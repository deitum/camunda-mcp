/** Which of the four authentication schemes the server was configured with. */
export type CamundaAuthMode = 'none' | 'basic' | 'bearer' | 'oauth';

/**
 * How a token reaches the engine.
 *
 * `header` (`Authorization: Bearer …`) is the default and what a plain Camunda
 * distribution expects. `cookie` exists because an engine is often published
 * behind a reverse proxy or an OIDC filter that reads the token from a cookie
 * and ignores the `Authorization` header entirely.
 */
export type TokenTransport = 'header' | 'cookie';

/**
 * HTTP Basic — the scheme Camunda's own `ProcessEngineAuthenticationFilter`
 * speaks, and what a stock distribution is set up with.
 */
export interface BasicAuthConfig {
  mode: 'basic';
  username: string;
  password: string;
}

/** A token obtained elsewhere and handed to this server ready-made. */
export interface BearerAuthConfig {
  mode: 'bearer';
  token: string;
  transport: TokenTransport;
  /** Only consulted when `transport` is `cookie`. */
  cookieName: string;
}

/**
 * An OAuth2 / OIDC token endpoint this server calls itself, and keeps calling as
 * tokens expire.
 */
export interface OAuthConfig {
  mode: 'oauth';
  /** Full token endpoint, e.g. `…/realms/<realm>/protocol/openid-connect/token`. */
  tokenUrl: string;
  clientId: string;
  /** Omitted for a public client. */
  clientSecret?: string;
  grantType: 'password' | 'client_credentials';
  /** Required by the password grant, absent for client credentials. */
  username?: string;
  password?: string;
  scope?: string;
  transport: TokenTransport;
  /** Only consulted when `transport` is `cookie`. */
  cookieName: string;
}

export type CamundaAuthConfig = BasicAuthConfig | BearerAuthConfig | OAuthConfig;

/** Everything the server needs, resolved from the environment once at startup. */
export interface CamundaConfig {
  /**
   * Engine REST root — either a standalone `…/engine-rest` or the webapp's
   * engine API (`…/camunda/api/engine/engine/default`).
   */
  baseUrl: string;
  /** Absent when the engine needs no authentication. */
  auth?: CamundaAuthConfig;
  /** Whether the tools that change engine state are registered at all. */
  allowWrite: boolean;
  defaultMaxResults: number;
  timeoutMs: number;
}

/** Supplies a token, refreshing it as needed. */
export interface TokenProvider {
  /** `force` discards the cached token first (used after a 401). */
  token(options?: { force?: boolean }): Promise<string>;
}

/** A Camunda typed value — the `{ value, type }` envelope the engine speaks. */
export interface CamundaVariable {
  value: unknown;
  type?: string;
  valueInfo?: Record<string, unknown>;
}

/** A node of `GET /process-instance/{id}/activity-instances`. */
export interface ActivityInstanceTree {
  id: string;
  activityId: string;
  activityName?: string;
  activityType?: string;
  childActivityInstances?: ActivityInstanceTree[];
  childTransitionInstances?: ActivityInstanceTree[];
}

/** One instruction of `POST /process-instance/{id}/modification`. */
export interface ModificationInstruction {
  type: 'cancel' | 'startBeforeActivity' | 'startAfterActivity' | 'startTransition';
  activityId?: string;
  activityInstanceId?: string;
  variables?: Record<string, CamundaVariable>;
}

/** The subset of `fetch` this package uses; injected so tests never hit the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
