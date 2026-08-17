import {
  COOKIE_NAME_PATTERN,
  DEFAULT_AUTH_COOKIE_NAME,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_CAP,
  REQUEST_TIMEOUT_MS,
} from './camunda.constants';
import {
  type CamundaAuthConfig,
  type CamundaAuthMode,
  type CamundaConfig,
  type TokenTransport,
} from './camunda.types';

const AUTH_MODES = ['none', 'basic', 'bearer', 'oauth'] as const;
const TRANSPORTS = ['header', 'cookie'] as const;
const GRANT_TYPES = ['password', 'client_credentials'] as const;

/**
 * A value the user never filled in. MCP client configs (VS Code's `mcp.json`
 * and the several apps that copied its syntax) carry `${input:NAME}` markers
 * that are substituted when the server is added; leaving a field empty keeps
 * the literal marker, which would otherwise be sent as a username.
 */
const UNFILLED_PLACEHOLDER = /^\$\{input:[A-Za-z0-9_]+\}$/;

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value || UNFILLED_PLACEHOLDER.test(value)) {
    return undefined;
  }
  return value;
}

const TRUTHY = new Set(['true', '1', 'yes']);
const FALSY = new Set(['false', '0', 'no']);

/**
 * A flag. Anything that reads as neither a yes nor a no leaves `fallback` in
 * place, and every default here is the safe side of its flag — writes off,
 * certificates verified — so a typo can only ever fail closed.
 */
function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const value = read(env, name)?.toLowerCase();
  if (value === undefined) {
    return fallback;
  }
  if (TRUTHY.has(value)) {
    return true;
  }
  if (FALSY.has(value)) {
    return false;
  }
  return fallback;
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = read(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function readEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = read(env, name)?.toLowerCase();
  if (raw === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(' | ')}, got "${raw}"`);
  }
  return raw as T;
}

function readCookieName(env: NodeJS.ProcessEnv): string {
  const value = read(env, 'CAMUNDA_COOKIE_NAME') ?? DEFAULT_AUTH_COOKIE_NAME;
  if (!COOKIE_NAME_PATTERN.test(value)) {
    throw new Error(`CAMUNDA_COOKIE_NAME must be a valid cookie name, got "${value}"`);
  }
  return value;
}

/**
 * Which scheme the environment describes.
 *
 * A mode is inferred from the variable that only that mode uses, so the common
 * setups need no `CAMUNDA_AUTH` at all. Deliberately generous: one OAuth-only
 * variable is enough to pick `oauth`, so that a half-filled set fails with
 * "missing CAMUNDA_TOKEN_URL" instead of silently degrading to no
 * authentication and answering every tool call with the engine's login page.
 *
 * `CAMUNDA_COOKIE_NAME` and `CAMUNDA_AUTH_TRANSPORT` are not part of this: they
 * name the transport, not a credential, so on their own they neither turn
 * authentication on nor count as a missing half of it.
 */
function inferMode(env: NodeJS.ProcessEnv): CamundaAuthMode {
  const isSet = (name: string): boolean => read(env, name) !== undefined;

  if (isSet('CAMUNDA_TOKEN_URL') || isSet('CAMUNDA_CLIENT_ID') || isSet('CAMUNDA_CLIENT_SECRET')) {
    return 'oauth';
  }
  if (isSet('CAMUNDA_TOKEN')) {
    return 'bearer';
  }
  if (isSet('CAMUNDA_USERNAME') || isSet('CAMUNDA_PASSWORD')) {
    return 'basic';
  }
  return 'none';
}

/**
 * Reads variables that must all be present, failing at startup when they are
 * not: a half-filled set of credentials means a typo, and saying so is friendlier
 * than every tool answering with the engine's login redirect.
 */
function requireAll(
  env: NodeJS.ProcessEnv,
  mode: CamundaAuthMode,
  names: string[],
  hint: string,
): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of names) {
    const value = read(env, name);
    if (value === undefined) {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Incomplete ${mode} credentials — missing ${missing.join(', ')}. ${hint} ` +
        'Unset all of them (and CAMUNDA_AUTH) to talk to an engine that needs no authentication.',
    );
  }
  return values;
}

function readTransport(env: NodeJS.ProcessEnv): TokenTransport {
  return readEnum(env, 'CAMUNDA_AUTH_TRANSPORT', TRANSPORTS) ?? 'header';
}

function readAuth(env: NodeJS.ProcessEnv): CamundaAuthConfig | undefined {
  const mode = readEnum(env, 'CAMUNDA_AUTH', AUTH_MODES) ?? inferMode(env);

  if (mode === 'none') {
    return undefined;
  }

  if (mode === 'basic') {
    const values = requireAll(
      env,
      mode,
      ['CAMUNDA_USERNAME', 'CAMUNDA_PASSWORD'],
      'HTTP Basic needs both.',
    );
    return {
      mode,
      username: values.CAMUNDA_USERNAME,
      password: values.CAMUNDA_PASSWORD,
    };
  }

  if (mode === 'bearer') {
    const values = requireAll(
      env,
      mode,
      ['CAMUNDA_TOKEN'],
      'CAMUNDA_TOKEN is the ready-made token to send; use CAMUNDA_AUTH=oauth to have this server ' +
        'fetch one instead.',
    );
    return {
      mode,
      token: values.CAMUNDA_TOKEN,
      transport: readTransport(env),
      cookieName: readCookieName(env),
    };
  }

  const username = read(env, 'CAMUNDA_USERNAME');
  const password = read(env, 'CAMUNDA_PASSWORD');
  const grantType =
    readEnum(env, 'CAMUNDA_GRANT_TYPE', GRANT_TYPES) ??
    ((username ?? password) ? 'password' : 'client_credentials');

  const required = ['CAMUNDA_TOKEN_URL', 'CAMUNDA_CLIENT_ID'];
  if (grantType === 'password') {
    required.push('CAMUNDA_USERNAME', 'CAMUNDA_PASSWORD');
  }
  const values = requireAll(
    env,
    mode,
    required,
    grantType === 'password'
      ? 'The password grant needs the token endpoint, the client and the user; ' +
          'CAMUNDA_CLIENT_SECRET only for a confidential client.'
      : 'The client-credentials grant needs the token endpoint and the client ' +
          '(CAMUNDA_CLIENT_SECRET too, unless the client is public).',
  );

  const clientSecret = read(env, 'CAMUNDA_CLIENT_SECRET');
  const scope = read(env, 'CAMUNDA_SCOPE');

  return {
    mode,
    tokenUrl: values.CAMUNDA_TOKEN_URL,
    clientId: values.CAMUNDA_CLIENT_ID,
    ...(clientSecret ? { clientSecret } : {}),
    grantType,
    ...(grantType === 'password'
      ? { username: values.CAMUNDA_USERNAME, password: values.CAMUNDA_PASSWORD }
      : {}),
    ...(scope ? { scope } : {}),
    transport: readTransport(env),
    cookieName: readCookieName(env),
  };
}

/** Reads and validates the server's configuration from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CamundaConfig {
  const baseUrl = read(env, 'CAMUNDA_BASE_URL');
  if (!baseUrl) {
    throw new Error(
      'CAMUNDA_BASE_URL is required — the engine REST root, e.g. ' +
        'https://host/engine-rest or https://host/camunda/api/engine/engine/default',
    );
  }

  const defaultMaxResults = Math.min(
    readNumber(env, 'CAMUNDA_MAX_RESULTS', DEFAULT_MAX_RESULTS),
    MAX_RESULTS_CAP,
  );
  const auth = readAuth(env);

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    ...(auth ? { auth } : {}),
    allowWrite: readBoolean(env, 'CAMUNDA_ALLOW_WRITE'),
    sslVerify: readBoolean(env, 'CAMUNDA_SSL_VERIFY', true),
    defaultMaxResults,
    timeoutMs: readNumber(env, 'CAMUNDA_TIMEOUT_MS', REQUEST_TIMEOUT_MS),
  };
}

/** One line for the startup banner: which scheme is in play and how it travels. */
export function describeAuth(auth: CamundaAuthConfig | undefined): string {
  if (!auth) {
    return 'none';
  }
  if (auth.mode === 'basic') {
    return `basic (${auth.username})`;
  }
  const transport =
    auth.transport === 'cookie' ? `cookie ${auth.cookieName}` : 'Authorization: Bearer';
  return auth.mode === 'bearer'
    ? `bearer token → ${transport}`
    : `oauth ${auth.grantType} → ${transport}`;
}
