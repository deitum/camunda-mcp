import { TOKEN_EXPIRY_SKEW_MS, TOKEN_TIMEOUT_MS } from './camunda.constants';
import {
  type CamundaAuthConfig,
  type FetchLike,
  type OAuthConfig,
  type TokenProvider,
} from './camunda.types';
import { describeError } from './errors';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  value: string;
  /** Wall-clock ms after which the token is treated as gone (skew included). */
  expiresAt: number;
}

export interface TokenProviderDeps {
  fetch?: FetchLike;
  now?: () => number;
}

/** Hands out a token that was configured directly, with nothing to refresh. */
export function createStaticTokenProvider(token: string): TokenProvider {
  return { token: () => Promise.resolve(token) };
}

/**
 * Access tokens from an OAuth2 / OIDC token endpoint, by either the password or
 * the client-credentials grant.
 *
 * The token is cached until shortly before it expires and renewed through the
 * refresh token when the provider issued one: a single agent turn can fire a
 * dozen tool calls, and one grant per call is both slow and a good way to trip
 * account lockout.
 *
 * How the token then reaches the engine is not decided here — it goes in a
 * header or in a cookie, see `client.ts`.
 */
export function createTokenProvider(
  auth: OAuthConfig,
  deps: TokenProviderDeps = {},
): TokenProvider {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());

  let cached: CachedToken | undefined;
  let refreshToken: string | undefined;
  // Concurrent tool calls must not each start their own grant.
  let inFlight: Promise<string> | undefined;

  const request = async (form: Record<string, string>): Promise<string> => {
    const body = new URLSearchParams({
      client_id: auth.clientId,
      ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
      ...(auth.scope ? { scope: auth.scope } : {}),
      ...form,
    });

    let response: Response;
    try {
      response = await doFetch(auth.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Cannot reach the token endpoint ${auth.tokenUrl}: ${describeError(error)}`, {
        cause: error,
      });
    }

    const text = await response.text();
    let payload: TokenResponse;
    try {
      payload = text ? (JSON.parse(text) as TokenResponse) : {};
    } catch (error) {
      // A non-JSON body means we are not talking to a token endpoint at all.
      throw new Error(
        `Token endpoint ${auth.tokenUrl} answered ${response.status} with a non-JSON body — ` +
          'check CAMUNDA_TOKEN_URL.',
        { cause: error },
      );
    }

    if (!response.ok || !payload.access_token) {
      const detail = payload.error_description ?? payload.error ?? text.slice(0, 200);
      throw new Error(`Token request failed (${response.status}): ${detail}`);
    }

    refreshToken = payload.refresh_token;
    cached = {
      value: payload.access_token,
      expiresAt: now() + (payload.expires_in ?? 60) * 1000 - TOKEN_EXPIRY_SKEW_MS,
    };
    return payload.access_token;
  };

  const grant = async (): Promise<string> => {
    if (auth.grantType === 'client_credentials') {
      return request({ grant_type: 'client_credentials' });
    }
    if (auth.username === undefined || auth.password === undefined) {
      // `loadConfig` rules this out; a hand-built config could not.
      throw new Error('The password grant needs both a username and a password.');
    }
    return request({
      grant_type: 'password',
      username: auth.username,
      password: auth.password,
    });
  };

  const renew = async (): Promise<string> => {
    if (refreshToken) {
      try {
        return await request({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });
      } catch {
        // An expired refresh token is normal; fall through to a fresh grant.
        refreshToken = undefined;
      }
    }
    return grant();
  };

  return {
    async token(options = {}): Promise<string> {
      if (options.force) {
        cached = undefined;
      }
      if (cached && cached.expiresAt > now()) {
        return cached.value;
      }
      inFlight ??= renew().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

/**
 * The provider a given configuration needs, if any: Basic auth carries its
 * credentials on every request and has no token to hand out.
 */
export function createAuthTokenProvider(
  auth: CamundaAuthConfig | undefined,
  deps: TokenProviderDeps = {},
): TokenProvider | undefined {
  if (!auth || auth.mode === 'basic') {
    return undefined;
  }
  return auth.mode === 'bearer'
    ? createStaticTokenProvider(auth.token)
    : createTokenProvider(auth, deps);
}
