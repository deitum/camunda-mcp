import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { applySslVerify } from './tls';

describe('applySslVerify', () => {
  test('leaves the process alone while verification is on', () => {
    const env: NodeJS.ProcessEnv = {};

    applySslVerify(true, env);

    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  });

  // Node's `fetch` reads this variable at connect time, so setting it here —
  // after the process has started — is what actually reaches the engine.
  test('switches Node certificate verification off', () => {
    const env: NodeJS.ProcessEnv = {};

    applySslVerify(false, env);

    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  });

  test('never turns an operator’s own NODE_TLS_REJECT_UNAUTHORIZED=0 back on', () => {
    const env: NodeJS.ProcessEnv = { NODE_TLS_REJECT_UNAUTHORIZED: '0' };

    applySslVerify(true, env);

    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  });
});
