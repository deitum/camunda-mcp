import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { describeError } from './errors';

/** The shape `fetch` throws: a bare TypeError with the real reason in `cause`. */
function fetchFailure(code: string, message: string): Error {
  const cause = Object.assign(new Error(message), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('describeError', () => {
  test('unfolds the cause chain fetch hides', () => {
    const error = fetchFailure('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443');

    assert.equal(
      describeError(error),
      'fetch failed — ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443',
    );
  });

  // The issuing root CA is in the system store (so curl works) but not in
  // Node's, and "fetch failed" gives no hint of that.
  test('names the fix for an untrusted certificate chain', () => {
    const message = describeError(
      fetchFailure('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'),
    );

    assert.match(message, /SELF_SIGNED_CERT_IN_CHAIN/);
    assert.match(message, /NODE_EXTRA_CA_CERTS/);
    assert.match(message, /CAMUNDA_SSL_VERIFY=false/);
  });

  test('leaves an ordinary error alone', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
    assert.equal(describeError('boom'), 'boom');
  });
});
