#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SERVER_INFO } from './camunda.constants';
import { describeAuth, loadConfig } from './config';
import { createCamundaServer } from './server';
import { applySslVerify } from './tls';

/**
 * stdio entry point: an MCP client spawns this process and speaks the protocol
 * over stdin/stdout. Nothing may be written to stdout except protocol frames —
 * every diagnostic goes to stderr.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  applySslVerify(config.sslVerify);
  const server = createCamundaServer(config);

  await server.connect(new StdioServerTransport());
  console.error(
    `${SERVER_INFO.name} ${SERVER_INFO.version} ready — engine ${config.baseUrl}, ` +
      `auth ${describeAuth(config.auth)}, write tools ${config.allowWrite ? 'on' : 'off'}` +
      // Loud, because it is the one setting that makes the connection insecure.
      (config.sslVerify ? '' : ', TLS verification OFF (CAMUNDA_SSL_VERIFY=false)'),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
