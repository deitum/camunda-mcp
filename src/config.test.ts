import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { describeAuth, loadConfig } from './config';

const BASE = { CAMUNDA_BASE_URL: 'https://camunda.example/engine-rest/' };

const oauth = {
  CAMUNDA_TOKEN_URL: 'https://camunda.example/realms/demo/protocol/openid-connect/token',
  CAMUNDA_CLIENT_ID: 'camunda-client',
  CAMUNDA_USERNAME: 'user',
  CAMUNDA_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  test('reads the engine URL and drops its trailing slash', () => {
    const config = loadConfig({ ...BASE });

    assert.equal(config.baseUrl, 'https://camunda.example/engine-rest');
    assert.equal(config.auth, undefined);
    assert.equal(config.allowWrite, false);
  });

  test('fails without an engine URL', () => {
    assert.throws(() => loadConfig({}), /CAMUNDA_BASE_URL is required/);
  });

  test('enables the write tools only on an explicit truthy flag', () => {
    assert.equal(loadConfig({ ...BASE, CAMUNDA_ALLOW_WRITE: 'true' }).allowWrite, true);
    assert.equal(loadConfig({ ...BASE, CAMUNDA_ALLOW_WRITE: '1' }).allowWrite, true);
    assert.equal(loadConfig({ ...BASE, CAMUNDA_ALLOW_WRITE: 'false' }).allowWrite, false);
    assert.equal(loadConfig({ ...BASE, CAMUNDA_ALLOW_WRITE: 'maybe' }).allowWrite, false);
  });

  test('caps the default page size and rejects nonsense numbers', () => {
    assert.equal(loadConfig({ ...BASE, CAMUNDA_MAX_RESULTS: '5000' }).defaultMaxResults, 100);
    assert.equal(loadConfig({ ...BASE, CAMUNDA_MAX_RESULTS: '5' }).defaultMaxResults, 5);
    assert.throws(() => loadConfig({ ...BASE, CAMUNDA_MAX_RESULTS: 'ten' }), /positive number/);
  });
});

describe('loadConfig: which authentication mode', () => {
  test('no credentials at all means none', () => {
    assert.equal(loadConfig({ ...BASE }).auth, undefined);
  });

  test('a username and a password mean HTTP Basic', () => {
    assert.deepEqual(
      loadConfig({
        ...BASE,
        CAMUNDA_USERNAME: 'demo',
        CAMUNDA_PASSWORD: 'demo',
      }).auth,
      { mode: 'basic', username: 'demo', password: 'demo' },
    );
  });

  test('a ready-made token means bearer', () => {
    assert.deepEqual(loadConfig({ ...BASE, CAMUNDA_TOKEN: 'abc' }).auth, {
      mode: 'bearer',
      token: 'abc',
      transport: 'header',
      cookieName: 'JWT',
    });
  });

  test('a token endpoint means oauth, with the password grant when a user is given', () => {
    assert.deepEqual(loadConfig({ ...BASE, ...oauth, CAMUNDA_CLIENT_SECRET: 'shh' }).auth, {
      mode: 'oauth',
      tokenUrl: oauth.CAMUNDA_TOKEN_URL,
      clientId: 'camunda-client',
      clientSecret: 'shh',
      grantType: 'password',
      username: 'user',
      password: 'secret',
      transport: 'header',
      cookieName: 'JWT',
    });
  });

  test('a token endpoint without a user means the client-credentials grant', () => {
    const config = loadConfig({
      ...BASE,
      CAMUNDA_TOKEN_URL: oauth.CAMUNDA_TOKEN_URL,
      CAMUNDA_CLIENT_ID: 'camunda-client',
      CAMUNDA_CLIENT_SECRET: 'shh',
      CAMUNDA_SCOPE: 'camunda-rest',
    });

    assert.deepEqual(config.auth, {
      mode: 'oauth',
      tokenUrl: oauth.CAMUNDA_TOKEN_URL,
      clientId: 'camunda-client',
      clientSecret: 'shh',
      grantType: 'client_credentials',
      scope: 'camunda-rest',
      transport: 'header',
      cookieName: 'JWT',
    });
  });

  // Basic is inferred from a username; the explicit mode is what lets someone
  // point this at an engine whose variables would otherwise read as oauth.
  test('CAMUNDA_AUTH overrides the inference', () => {
    const env = { ...BASE, ...oauth, CAMUNDA_AUTH: 'basic' };

    assert.deepEqual(loadConfig(env).auth, {
      mode: 'basic',
      username: 'user',
      password: 'secret',
    });
  });

  test('CAMUNDA_AUTH=none ignores credentials that are lying around', () => {
    assert.equal(loadConfig({ ...BASE, ...oauth, CAMUNDA_AUTH: 'none' }).auth, undefined);
  });

  test('rejects an unknown mode instead of quietly disabling authentication', () => {
    assert.throws(
      () => loadConfig({ ...BASE, ...oauth, CAMUNDA_AUTH: 'kerberos' }),
      /CAMUNDA_AUTH must be one of none \| basic \| bearer \| oauth/,
    );
  });
});

describe('loadConfig: incomplete credentials fail at startup', () => {
  test('a username without a password', () => {
    assert.throws(
      () => loadConfig({ ...BASE, CAMUNDA_USERNAME: 'demo' }),
      /Incomplete basic credentials — missing CAMUNDA_PASSWORD/,
    );
  });

  test('a client without a token endpoint', () => {
    assert.throws(
      () => loadConfig({ ...BASE, CAMUNDA_CLIENT_ID: 'camunda-client' }),
      /Incomplete oauth credentials — missing CAMUNDA_TOKEN_URL/,
    );
  });

  test('a password grant without the user', () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          CAMUNDA_TOKEN_URL: oauth.CAMUNDA_TOKEN_URL,
          CAMUNDA_CLIENT_ID: 'camunda-client',
          CAMUNDA_GRANT_TYPE: 'password',
        }),
      /missing CAMUNDA_USERNAME, CAMUNDA_PASSWORD/,
    );
  });

  test('bearer without a token', () => {
    assert.throws(
      () => loadConfig({ ...BASE, CAMUNDA_AUTH: 'bearer' }),
      /Incomplete bearer credentials — missing CAMUNDA_TOKEN/,
    );
  });

  test('an empty half of a set', () => {
    assert.throws(
      () => loadConfig({ ...BASE, ...oauth, CAMUNDA_PASSWORD: '' }),
      /missing CAMUNDA_PASSWORD/,
    );
  });

  // MCP client configs ship `${input:NAME}` markers; an empty field in the
  // client's dialog leaves the marker in place, and sending it as a username
  // would look like a wrong password rather than a missing one.
  test('an unfilled ${input:NAME} placeholder counts as unset', () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          ...oauth,
          CAMUNDA_PASSWORD: '${input:CAMUNDA_PASSWORD}',
        }),
      /missing CAMUNDA_PASSWORD/,
    );

    const config = loadConfig({
      ...BASE,
      CAMUNDA_TOKEN: '${input:CAMUNDA_TOKEN}',
    });
    assert.equal(config.auth, undefined);
  });
});

describe('loadConfig: how the token travels', () => {
  test('defaults to the Authorization header', () => {
    const config = loadConfig({ ...BASE, ...oauth });

    assert.equal(config.auth?.mode === 'oauth' && config.auth.transport, 'header');
  });

  test('switches to a cookie on request', () => {
    const config = loadConfig({
      ...BASE,
      ...oauth,
      CAMUNDA_AUTH_TRANSPORT: 'cookie',
    });

    assert.equal(config.auth?.mode === 'oauth' && config.auth.transport, 'cookie');
    assert.equal(config.auth?.mode === 'oauth' && config.auth.cookieName, 'JWT');
  });

  test('takes the cookie name from the environment', () => {
    const config = loadConfig({
      ...BASE,
      ...oauth,
      CAMUNDA_AUTH_TRANSPORT: 'cookie',
      CAMUNDA_COOKIE_NAME: 'SESSIONJWT',
    });

    assert.equal(config.auth?.mode === 'oauth' && config.auth.cookieName, 'SESSIONJWT');
  });

  // A name carrying `;` or `=` would append a header of its own to every request.
  test('rejects a cookie name that is not one', () => {
    assert.throws(
      () => loadConfig({ ...BASE, ...oauth, CAMUNDA_COOKIE_NAME: 'bad name;' }),
      /valid cookie name/,
    );
  });

  test('rejects an unknown transport', () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          ...oauth,
          CAMUNDA_AUTH_TRANSPORT: 'querystring',
        }),
      /CAMUNDA_AUTH_TRANSPORT must be one of header \| cookie/,
    );
  });

  // The transport says how a token travels, not whether there is one: on their
  // own neither variable may turn authentication on nor read as a half-filled set.
  test('ignores a lone cookie name or transport', () => {
    assert.equal(loadConfig({ ...BASE, CAMUNDA_COOKIE_NAME: 'SESSIONJWT' }).auth, undefined);
    assert.equal(loadConfig({ ...BASE, CAMUNDA_AUTH_TRANSPORT: 'cookie' }).auth, undefined);
  });
});

describe('describeAuth', () => {
  test('says what the startup banner needs to say', () => {
    const auth = (env: Record<string, string>): string =>
      describeAuth(loadConfig({ ...BASE, ...env }).auth);

    assert.equal(auth({}), 'none');
    assert.equal(auth({ CAMUNDA_USERNAME: 'demo', CAMUNDA_PASSWORD: 'demo' }), 'basic (demo)');
    assert.equal(auth({ CAMUNDA_TOKEN: 'abc' }), 'bearer token → Authorization: Bearer');
    assert.equal(auth({ ...oauth }), 'oauth password → Authorization: Bearer');
    assert.equal(
      auth({
        ...oauth,
        CAMUNDA_AUTH_TRANSPORT: 'cookie',
        CAMUNDA_COOKIE_NAME: 'SESSIONJWT',
      }),
      'oauth password → cookie SESSIONJWT',
    );
  });

  // The banner goes to stderr, where a user reads it while debugging a 302.
  test('never prints a secret', () => {
    const line = describeAuth(loadConfig({ ...BASE, ...oauth, CAMUNDA_CLIENT_SECRET: 'shh' }).auth);

    assert.equal(line.includes('shh'), false);
    assert.equal(line.includes('secret'), false);
  });
});
