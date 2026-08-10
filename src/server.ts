import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createAuthTokenProvider } from './auth';
import { SERVER_INFO } from './camunda.constants';
import { type CamundaConfig, type FetchLike, type TokenProvider } from './camunda.types';
import { CamundaClient } from './client';
import { registerReadTools } from './tools/read-tools';
import { registerWriteTools } from './tools/write-tools';

export interface ServerDeps {
  /** Injected so a test can drive the tools without a live engine. */
  fetch?: FetchLike;
  /** Injected so a test never performs a token grant. */
  tokens?: TokenProvider;
}

/**
 * Builds the MCP server for one Camunda engine.
 *
 * The write half is registered rather than merely refused: a model cannot be
 * told "do not touch" reliably, but it cannot call a tool it was never shown.
 */
export function createCamundaServer(config: CamundaConfig, deps: ServerDeps = {}): McpServer {
  const tokens =
    deps.tokens ??
    createAuthTokenProvider(config.auth, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  const client = new CamundaClient(config, tokens, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Camunda 7 engine. Decisions (DMN) and processes are separate: decision definitions describe ' +
      'decision tables, process definitions describe BPMN flows. Start from the *_list_* tools to ' +
      'find a key, then fetch the XML or the history for detail. Activity ids for a modification ' +
      'come from the BPMN XML or from camunda_get_activity_instances.',
  });

  registerReadTools(server, client, config);
  if (config.allowWrite) {
    registerWriteTools(server, client);
  }

  return server;
}
