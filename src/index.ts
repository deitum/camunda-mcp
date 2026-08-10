/**
 * Library entry point, for embedding the server in another process (a custom
 * transport, an in-process MCP host, a test harness). The stdio binary is
 * `cli.ts`, which is what `npx camunda-mcp` runs.
 */
export {
  createAuthTokenProvider,
  createStaticTokenProvider,
  createTokenProvider,
  type TokenProviderDeps,
} from './auth';
export { SERVER_INFO, SERVER_VERSION } from './camunda.constants';
export type {
  ActivityInstanceTree,
  BasicAuthConfig,
  BearerAuthConfig,
  CamundaAuthConfig,
  CamundaAuthMode,
  CamundaConfig,
  CamundaVariable,
  FetchLike,
  ModificationInstruction,
  OAuthConfig,
  TokenProvider,
  TokenTransport,
} from './camunda.types';
export { CamundaClient, CamundaError, type RequestOptions } from './client';
export { describeAuth, loadConfig } from './config';
export { createCamundaServer, type ServerDeps } from './server';
