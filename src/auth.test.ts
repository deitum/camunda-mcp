import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { createAuthTokenProvider, createStaticTokenProvider, createTokenProvider } from './auth';
import { type FetchLike, type OAuthConfig } from './camunda.types';

const AUTH: OAuthConfig = {
  mode: 'oauth',
  tokenUrl: 'https://idp.example/realms/demo/protocol/openid-connect/token',
  clientId: 'camunda-client',
  clientSecret: 'shh',
  grantType: 'password',
  username: 'user',
  password: 'secret',
  transport: 'header',
  cookieName: 'JWT',
};

/** A token endpoint that answers with the queued payloads, recording each form. */
function stubTokenEndpoint(payloads: Record<string, unknown>[]): {
  fetch: FetchLike;
  forms: URLSearchParams[];
} {
  const forms: URLSearchParams[] = [];
  const queue = [...payloads];

  const fetch: FetchLike = (_input, init) => {
    forms.push(new URLSearchParams(String(init?.body ?? '')));
    const payload = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return { fetch, forms };
}

describe('createTokenProvider', () => {
  test('performs the password grant and caches the token', async () => {
    const { fetch, forms } = stubTokenEndpoint([{ access_token: 'first', expires_in: 300 }]);
    const provider = createTokenProvider(AUTH, { fetch });

    assert.equal(await provider.token(), 'first');
    assert.equal(await provider.token(), 'first');

    assert.equal(forms.length, 1);
    assert.equal(forms[0].get('grant_type'), 'password');
    assert.equal(forms[0].get('client_id'), 'camunda-client');
    assert.equal(forms[0].get('client_secret'), 'shh');
    assert.equal(forms[0].get('username'), 'user');
    assert.equal(forms[0].get('password'), 'secret');
  });

  // Service accounts, and every engine whose OIDC client has no human behind it.
  test('performs the client-credentials grant without a user', async () => {
    const { fetch, forms } = stubTokenEndpoint([{ access_token: 'machine', expires_in: 300 }]);
    const { username: _username, password: _password, ...client } = AUTH;
    const provider = createTokenProvider({ ...client, grantType: 'client_credentials' }, { fetch });

    assert.equal(await provider.token(), 'machine');

    assert.equal(forms[0].get('grant_type'), 'client_credentials');
    assert.equal(forms[0].get('client_id'), 'camunda-client');
    assert.equal(forms[0].get('username'), null);
    assert.equal(forms[0].get('password'), null);
  });

  test('sends the scope when one is configured', async () => {
    const { fetch, forms } = stubTokenEndpoint([{ access_token: 'scoped', expires_in: 300 }]);
    const provider = createTokenProvider({ ...AUTH, scope: 'camunda-rest openid' }, { fetch });

    await provider.token();

    assert.equal(forms[0].get('scope'), 'camunda-rest openid');
  });

  test('refreshes with the refresh token once the access token ages out', async () => {
    const { fetch, forms } = stubTokenEndpoint([
      { access_token: 'first', refresh_token: 'r1', expires_in: 60 },
      { access_token: 'second', expires_in: 60 },
    ]);
    let clock = 0;
    const provider = createTokenProvider(AUTH, { fetch, now: () => clock });

    assert.equal(await provider.token(), 'first');
    // 60s expiry minus the 30s skew: the token is stale after half a minute.
    clock = 31_000;
    assert.equal(await provider.token(), 'second');

    assert.equal(forms.length, 2);
    assert.equal(forms[1].get('grant_type'), 'refresh_token');
    assert.equal(forms[1].get('refresh_token'), 'r1');
  });

  test('falls back to a fresh grant when the refresh token is rejected', async () => {
    const forms: URLSearchParams[] = [];
    const fetch: FetchLike = (_input, init) => {
      const form = new URLSearchParams(String(init?.body ?? ''));
      forms.push(form);
      if (form.get('grant_type') === 'refresh_token') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'fresh',
            refresh_token: 'r',
            expires_in: 60,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    };

    let clock = 0;
    const provider = createTokenProvider(AUTH, { fetch, now: () => clock });

    assert.equal(await provider.token(), 'fresh');
    clock = 31_000;
    assert.equal(await provider.token(), 'fresh');

    assert.deepEqual(
      forms.map((form) => form.get('grant_type')),
      ['password', 'refresh_token', 'password'],
    );
  });

  test('force discards the cached token', async () => {
    const { fetch, forms } = stubTokenEndpoint([
      { access_token: 'first', expires_in: 300 },
      { access_token: 'second', expires_in: 300 },
    ]);
    const provider = createTokenProvider(AUTH, { fetch });

    assert.equal(await provider.token(), 'first');
    assert.equal(await provider.token({ force: true }), 'second');
    assert.equal(forms.length, 2);
  });

  // An agent turn fires several tool calls at once; each starting its own grant
  // is both slow and a fine way to trip account lockout.
  test('concurrent callers share one grant', async () => {
    const { fetch, forms } = stubTokenEndpoint([{ access_token: 'one', expires_in: 300 }]);
    const provider = createTokenProvider(AUTH, { fetch });

    const tokens = await Promise.all([provider.token(), provider.token(), provider.token()]);

    assert.deepEqual(tokens, ['one', 'one', 'one']);
    assert.equal(forms.length, 1);
  });

  test('reports what the identity provider said when the grant fails', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'unauthorized_client',
            error_description: 'Invalid client',
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      );

    await assert.rejects(
      () => createTokenProvider(AUTH, { fetch }).token(),
      /Token request failed \(401\): Invalid client/,
    );
  });

  test('says so when the token URL is not a token endpoint', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(new Response('<html>login</html>', { status: 200 }));

    await assert.rejects(
      () => createTokenProvider(AUTH, { fetch }).token(),
      /non-JSON body — check CAMUNDA_TOKEN_URL/,
    );
  });
});

describe('createStaticTokenProvider', () => {
  test('hands out the same token however hard it is asked', async () => {
    const provider = createStaticTokenProvider('abc');

    assert.equal(await provider.token(), 'abc');
    assert.equal(await provider.token({ force: true }), 'abc');
  });
});

describe('createAuthTokenProvider', () => {
  test('gives Basic and an open engine nothing to hand out', () => {
    assert.equal(createAuthTokenProvider(undefined), undefined);
    assert.equal(
      createAuthTokenProvider({
        mode: 'basic',
        username: 'demo',
        password: 'demo',
      }),
      undefined,
    );
  });

  test('wraps a configured token, and calls the endpoint for an oauth one', async () => {
    const staticProvider = createAuthTokenProvider({
      mode: 'bearer',
      token: 'abc',
      transport: 'header',
      cookieName: 'JWT',
    });
    assert.equal(await staticProvider?.token(), 'abc');

    const { fetch, forms } = stubTokenEndpoint([{ access_token: 'granted', expires_in: 300 }]);
    const oauthProvider = createAuthTokenProvider(AUTH, { fetch });

    assert.equal(await oauthProvider?.token(), 'granted');
    assert.equal(forms.length, 1);
  });
});
