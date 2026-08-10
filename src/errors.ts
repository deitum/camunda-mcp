/** TLS failures that mean "this Node process does not trust the issuing CA". */
const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);

const TLS_HINT =
  'The certificate chain is not trusted by Node (curl works because it uses the system store). ' +
  'Point NODE_EXTRA_CA_CERTS at the root certificate, or set NODE_TLS_REJECT_UNAUTHORIZED=0 for ' +
  'this process.';

/**
 * Flattens an error and its `cause` chain into one line.
 *
 * `fetch` reports every transport failure as the same useless `TypeError: fetch
 * failed` and hides the real reason in `cause` — which, against an internally
 * hosted engine, is almost always the CA chain. Saying that outright is the
 * difference between a one-minute fix and an afternoon.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  let tls = false;
  let cause: unknown = (error as { cause?: unknown }).cause;

  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code && TLS_CODES.has(code)) {
      tls = true;
    }
    parts.push(code ? `${code}: ${cause.message}` : cause.message);
    cause = (cause as { cause?: unknown }).cause;
  }

  return tls ? `${parts.join(' — ')}. ${TLS_HINT}` : parts.join(' — ');
}
