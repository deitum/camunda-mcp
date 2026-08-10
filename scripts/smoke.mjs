// Starts the built server over stdio and runs one MCP `initialize` +
// `tools/list` round-trip against it.
//
// `npm run check:package` proves the tarball is well-formed; this proves the
// binary in it actually boots — a broken shebang, a missing dependency or an
// accidental `console.log` on stdout all pass every other check in CI.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const server = spawn(process.execPath, ['dist/cli.js'], {
  env: {
    ...process.env,
    CAMUNDA_BASE_URL: 'http://127.0.0.1:1/engine-rest',
    CAMUNDA_ALLOW_WRITE: 'true',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: server.stdout });

const replies = new Map();
lines.on('line', (line) => {
  const message = JSON.parse(line);
  replies.get(message.id)?.(message);
});

const call = async (id, method, params = {}) => {
  const reply = new Promise((resolve) => replies.set(id, resolve));
  send({ jsonrpc: '2.0', id, method, params });
  return reply;
};

const timeout = setTimeout(() => {
  console.error('The server did not answer within 15s.');
  server.kill('SIGKILL');
  process.exit(1);
}, 15_000);

const initialized = await call(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const { result } = await call(2, 'tools/list');
const names = result.tools.map((tool) => tool.name);

clearTimeout(timeout);
server.kill();
await once(server, 'exit');

console.log(`${initialized.result.serverInfo.name} ${initialized.result.serverInfo.version}`);
console.log(`${names.length} tools: ${names.slice(0, 3).join(', ')}, …`);

// 17 read tools plus the 8 write ones CAMUNDA_ALLOW_WRITE turned on.
if (names.length !== 25) {
  console.error(`Expected 25 tools, got ${names.length}.`);
  process.exit(1);
}
