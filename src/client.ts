import {
  type CamundaAuthConfig,
  type CamundaConfig,
  type FetchLike,
  type TokenProvider,
} from './camunda.types';
import { describeError } from './errors';

/** An error carrying the engine's HTTP status, so a caller can react to 404 vs 500. */
export class CamundaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CamundaError';
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Response is not JSON (a deployment resource, a job stacktrace). */
  raw?: boolean;
}

/**
 * Thin typed wrapper over the Camunda 7 engine REST API.
 *
 * Two failure modes are handled explicitly, because both look like success to a
 * naive client:
 *
 * - an engine published behind an OIDC filter answers an unauthenticated call
 *   with `302 → …/openid-connect/auth` rather than `401`, and `fetch` would
 *   happily follow that redirect and hand back the login page as `200`. Such a
 *   filter often reads the token from a cookie and ignores the `Authorization`
 *   header — see `TokenTransport`;
 * - a wrong base URL (e.g. `/engine-rest` on a host where the engine lives under
 *   `/camunda/api/engine/engine/default`) is swallowed by whatever front-end
 *   owns that path, which tends to answer `200 text/html` for everything.
 */
export class CamundaClient {
  private readonly doFetch: FetchLike;

  constructor(
    private readonly config: CamundaConfig,
    private readonly tokens?: TokenProvider,
    deps: { fetch?: FetchLike } = {},
  ) {
    this.doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  put<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  private url(path: string, query: RequestOptions['query']): string {
    const url = new URL(`${this.config.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * The credentials for one attempt. `force` asks the provider for a brand-new
   * token, which is what an access token expiring mid-turn calls for.
   */
  private async authHeaders(force: boolean): Promise<Record<string, string>> {
    const auth = this.config.auth;
    if (!auth) {
      return {};
    }
    if (auth.mode === 'basic') {
      const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { authorization: `Basic ${credentials}` };
    }
    if (!this.tokens) {
      return {};
    }

    const token = await this.tokens.token({ force });
    return auth.transport === 'cookie'
      ? { cookie: `${auth.cookieName}=${token}` }
      : { authorization: `Bearer ${token}` };
  }

  /**
   * Only an OAuth token can be improved by asking again: a static token, Basic
   * credentials and an unauthenticated engine would all fail exactly the same
   * way twice.
   */
  private get canRetry(): boolean {
    return this.config.auth?.mode === 'oauth' && this.tokens !== undefined;
  }

  /**
   * `attempt` is 0 for the normal call and 1 for the single retry after the
   * engine refuses the token. Refusal arrives either as a 401/403 or, behind an
   * OIDC filter, as a redirect to the identity provider.
   */
  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions,
    attempt = 0,
  ): Promise<T> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(await this.authHeaders(attempt > 0)),
    };

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        // Never follow the OIDC redirect: doing so turns "not authenticated"
        // into a 200 carrying the identity provider's login page.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new CamundaError(0, `Cannot reach the engine at ${url}: ${describeError(error)}`);
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location') ?? '';
      const rejectedToken = location.includes('openid-connect') || location.includes('oauth2');
      // A token that aged out mid-turn shows up here rather than as a 401,
      // because the filter answers with the login redirect instead.
      if (rejectedToken && attempt === 0 && this.canRetry) {
        return this.request<T>(method, path, options, attempt + 1);
      }
      throw new CamundaError(
        response.status,
        rejectedToken
          ? `The engine redirected to the identity provider (${response.status}) — the ` +
              `credentials were not accepted. ${transportHint(this.config.auth)}`
          : `The engine redirected to ${location || '(no Location)'} — check CAMUNDA_BASE_URL.`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      if (attempt === 0 && this.canRetry) {
        return this.request<T>(method, path, options, attempt + 1);
      }
      throw new CamundaError(
        response.status,
        `Engine rejected the credentials (${response.status}).`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    if (!options.raw && contentType.includes('text/html')) {
      throw new CamundaError(
        response.status,
        `${url} returned HTML, not engine JSON — CAMUNDA_BASE_URL most likely does not point at ` +
          'the engine REST root (try …/engine-rest or …/camunda/api/engine/engine/default).',
      );
    }

    if (!response.ok) {
      throw new CamundaError(
        response.status,
        `${method} ${path} failed (${response.status}): ${engineMessage(text)}`,
      );
    }

    if (options.raw) {
      return text as T;
    }
    if (!text) {
      // 204 No Content — every write endpoint of the engine answers like this.
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CamundaError(
        response.status,
        `${method} ${path} returned a non-JSON body: ${text.slice(0, 200)}`,
      );
    }
  }
}

/**
 * What to try next when the identity provider, rather than the engine, answers.
 * Which advice is useful depends entirely on how the token is being sent, so the
 * message says what was sent before suggesting the alternative.
 */
function transportHint(auth: CamundaAuthConfig | undefined): string {
  if (!auth) {
    return (
      'No credentials are configured: set CAMUNDA_USERNAME/CAMUNDA_PASSWORD for HTTP Basic, ' +
      'CAMUNDA_TOKEN for a ready-made token, or CAMUNDA_TOKEN_URL/CAMUNDA_CLIENT_ID to have this ' +
      'server obtain one.'
    );
  }
  if (auth.mode === 'basic') {
    return (
      'HTTP Basic cannot satisfy an identity provider — configure CAMUNDA_TOKEN_URL and ' +
      'CAMUNDA_CLIENT_ID (CAMUNDA_AUTH=oauth) instead.'
    );
  }
  return auth.transport === 'cookie'
    ? `The token was sent in the cookie "${auth.cookieName}". Check CAMUNDA_COOKIE_NAME, or set ` +
        'CAMUNDA_AUTH_TRANSPORT=header if this engine reads the Authorization header.'
    : 'The token was sent as "Authorization: Bearer". Engines published behind an OIDC filter ' +
        'often read it from a cookie instead — try CAMUNDA_AUTH_TRANSPORT=cookie (the cookie is ' +
        'named by CAMUNDA_COOKIE_NAME, default JWT).';
}

/** Pulls the engine's `{ type, message }` out of an error body. */
function engineMessage(text: string): string {
  if (!text) {
    return '(empty body)';
  }
  try {
    const payload = JSON.parse(text) as { type?: string; message?: string };
    if (payload.message) {
      return payload.type ? `${payload.type}: ${payload.message}` : payload.message;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text.slice(0, 500);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}
