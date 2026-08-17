/**
 * Applies `CAMUNDA_SSL_VERIFY=false` — an escape hatch for an engine whose
 * certificate Node cannot verify, when adding its root to `NODE_EXTRA_CA_CERTS`
 * is not an option.
 *
 * The effect is process-wide rather than per-connection: `fetch` takes its TLS
 * settings from the process, and narrowing this to the engine alone would mean
 * shipping an `undici` dispatcher of our own for the sake of one flag. Which is
 * why only the entry point calls this — a library embedder owns its process and
 * decides for itself.
 *
 * Nothing is ever switched back on: an operator who exported
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` for the whole process meant it.
 */
export function applySslVerify(sslVerify: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (!sslVerify) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
}
