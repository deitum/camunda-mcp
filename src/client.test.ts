import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  type CamundaAuthConfig,
  type CamundaConfig,
  type FetchLike,
  type TokenProvider,
} from './camunda.types';
import { CamundaClient, CamundaError } from './client';

const CONFIG: CamundaConfig = {
  baseUrl: 'https://camunda.example/engine-rest',
  allowWrite: false,
  defaultMaxResults: 20,
  timeoutMs: 1_000,
};

const OAUTH: CamundaAuthConfig = {
  mode: 'oauth',
  tokenUrl: 'https://camunda.example/realms/demo/protocol/openid-connect/token',
  clientId: 'camunda-client',
  grantType: 'password',
  username: 'user',
  password: 'secret',
  transport: 'header',
  cookieName: 'JWT',
};

const BASIC: CamundaAuthConfig = {
  mode: 'basic',
  username: 'demo',
  password: 'demo',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const loginRedirect = (): Response =>
  new Response(null, {
    status: 302,
    headers: {
      location: 'https://idp.example/realms/demo/protocol/openid-connect/auth',
    },
  });

/** A token provider that hands out a new token every time it is forced. */
function stubTokens(): TokenProvider & { issued: string[] } {
  const issued: string[] = [];
  return {
    issued,
    token({ force } = {}) {
      if (force || issued.length === 0) {
        issued.push(`token-${issued.length + 1}`);
      }
      return Promise.resolve(issued[issued.length - 1]);
    },
  };
}

/** Runs one request against a stub engine and returns the headers it saw. */
async function headersOf(
  config: CamundaConfig,
  tokens?: TokenProvider,
): Promise<Record<string, string>> {
  const seen: Record<string, string>[] = [];
  const fetch: FetchLike = (_url, init) => {
    seen.push(init?.headers as Record<string, string>);
    return Promise.resolve(json([]));
  };

  await new CamundaClient(config, tokens, { fetch }).get('task');
  return seen[0];
}

describe('CamundaClient: the request it builds', () => {
  test('builds the URL and drops undefined query params', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = (url) => {
      urls.push(url);
      return Promise.resolve(json([{ id: 'x' }]));
    };

    const client = new CamundaClient(CONFIG, undefined, { fetch });
    await client.get('/decision-definition', {
      query: { keyLike: 'scoring', maxResults: 5, nameLike: undefined },
    });

    assert.equal(
      urls[0],
      'https://camunda.example/engine-rest/decision-definition?keyLike=scoring&maxResults=5',
    );
  });

  // Following it would turn "not authenticated" into a 200 carrying a login page.
  test('never follows a redirect', async () => {
    const inits: RequestInit[] = [];
    const fetch: FetchLike = (_url, init) => {
      inits.push(init as RequestInit);
      return Promise.resolve(json([]));
    };

    await new CamundaClient(CONFIG, undefined, { fetch }).get('task');

    assert.equal(inits[0].redirect, 'manual');
  });
});

describe('CamundaClient: how credentials are sent', () => {
  test('sends nothing when the engine needs no authentication', async () => {
    const headers = await headersOf(CONFIG);

    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
  });

  test('sends HTTP Basic on every request', async () => {
    const headers = await headersOf({ ...CONFIG, auth: BASIC });

    assert.equal(headers.authorization, `Basic ${Buffer.from('demo:demo').toString('base64')}`);
    assert.equal(headers.cookie, undefined);
  });

  test('sends a token as Authorization: Bearer by default', async () => {
    const headers = await headersOf({ ...CONFIG, auth: OAUTH }, stubTokens());

    assert.equal(headers.authorization, 'Bearer token-1');
    assert.equal(headers.cookie, undefined);
  });

  // An engine published behind an OIDC filter reads the token from a cookie and
  // ignores the Authorization header, so the header is not sent at all.
  test('sends a token in a cookie when the transport says so', async () => {
    const headers = await headersOf(
      {
        ...CONFIG,
        auth: { ...OAUTH, transport: 'cookie', cookieName: 'SESSIONJWT' },
      },
      stubTokens(),
    );

    assert.equal(headers.cookie, 'SESSIONJWT=token-1');
    assert.equal(headers.authorization, undefined);
  });

  test('sends a ready-made bearer token the same way', async () => {
    const auth: CamundaAuthConfig = {
      mode: 'bearer',
      token: 'abc',
      transport: 'header',
      cookieName: 'JWT',
    };

    const headers = await headersOf({ ...CONFIG, auth }, { token: () => Promise.resolve('abc') });
    assert.equal(headers.authorization, 'Bearer abc');

    const cookie = await headersOf(
      { ...CONFIG, auth: { ...auth, transport: 'cookie' } },
      { token: () => Promise.resolve('abc') },
    );
    assert.equal(cookie.cookie, 'JWT=abc');
  });
});

describe('CamundaClient: refusals', () => {
  test('retries a 401 once with a fresh oauth token', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = (_url, init) => {
      seen.push((init?.headers as Record<string, string>).authorization);
      return Promise.resolve(seen.length === 1 ? json({}, 401) : json({ id: 'ok' }));
    };

    const client = new CamundaClient({ ...CONFIG, auth: OAUTH }, stubTokens(), {
      fetch,
    });

    assert.deepEqual(await client.get<{ id: string }>('task'), { id: 'ok' });
    assert.deepEqual(seen, ['Bearer token-1', 'Bearer token-2']);
  });

  // Behind an OIDC filter an expired token comes back as the login redirect
  // rather than a 401, so the retry has to hang off this branch too.
  test('retries the login redirect once with a fresh oauth token', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = (_url, init) => {
      seen.push((init?.headers as Record<string, string>).cookie);
      return Promise.resolve(seen.length === 1 ? loginRedirect() : json({ version: '7.20.0' }));
    };

    const client = new CamundaClient(
      { ...CONFIG, auth: { ...OAUTH, transport: 'cookie' } },
      stubTokens(),
      { fetch },
    );

    assert.deepEqual(await client.get('version'), { version: '7.20.0' });
    assert.deepEqual(seen, ['JWT=token-1', 'JWT=token-2']);
  });

  // Asking a static token or Basic credentials again produces the same refusal.
  test('does not retry when there is nothing to refresh', async () => {
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(json({}, 401));
    };

    const client = new CamundaClient({ ...CONFIG, auth: BASIC }, undefined, {
      fetch,
    });

    await assert.rejects(() => client.get('task'), /rejected the credentials \(401\)/);
    assert.equal(calls, 1);
  });

  test('gives up after the retry', async () => {
    const fetch: FetchLike = () => Promise.resolve(json({}, 401));
    const client = new CamundaClient({ ...CONFIG, auth: OAUTH }, stubTokens(), {
      fetch,
    });

    await assert.rejects(() => client.get('task'), /rejected the credentials \(401\)/);
  });

  test('suggests the cookie transport when a bearer header is refused', async () => {
    const fetch: FetchLike = () => Promise.resolve(loginRedirect());
    const client = new CamundaClient({ ...CONFIG, auth: OAUTH }, stubTokens(), {
      fetch,
    });

    await assert.rejects(() => client.get('version'), /try CAMUNDA_AUTH_TRANSPORT=cookie/);
  });

  test('names the cookie when a cookie is refused', async () => {
    const fetch: FetchLike = () => Promise.resolve(loginRedirect());
    const client = new CamundaClient(
      {
        ...CONFIG,
        auth: { ...OAUTH, transport: 'cookie', cookieName: 'SESSIONJWT' },
      },
      stubTokens(),
      { fetch },
    );

    await assert.rejects(() => client.get('version'), /cookie "SESSIONJWT"/);
  });

  test('tells an unauthenticated caller which variables to set', async () => {
    const fetch: FetchLike = () => Promise.resolve(loginRedirect());
    const client = new CamundaClient(CONFIG, undefined, { fetch });

    await assert.rejects(() => client.get('version'), /No credentials are configured/);
  });

  test('says Basic cannot satisfy an identity provider', async () => {
    const fetch: FetchLike = () => Promise.resolve(loginRedirect());
    const client = new CamundaClient({ ...CONFIG, auth: BASIC }, undefined, {
      fetch,
    });

    await assert.rejects(() => client.get('version'), /HTTP Basic cannot satisfy/);
  });

  test('a redirect elsewhere points at the base URL instead', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(null, {
          status: 301,
          headers: { location: '/login.html' },
        }),
      );

    const client = new CamundaClient(CONFIG, undefined, { fetch });

    await assert.rejects(() => client.get('version'), /check CAMUNDA_BASE_URL/);
  });
});

describe('CamundaClient: responses', () => {
  // A wrong base URL is swallowed by whatever front-end owns that path, which
  // tends to answer 200 text/html for everything.
  test('rejects an HTML body as a wrong base URL', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );

    const client = new CamundaClient(CONFIG, undefined, { fetch });

    await assert.rejects(
      () => client.get('version'),
      /CAMUNDA_BASE_URL most likely does not point/,
    );
  });

  test('surfaces the engine error body', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        json(
          {
            type: 'RestException',
            message: 'Process instance with id x does not exist',
          },
          404,
        ),
      );

    const client = new CamundaClient(CONFIG, undefined, { fetch });

    await assert.rejects(
      () => client.get('process-instance/x'),
      (error: unknown) => {
        assert.ok(error instanceof CamundaError);
        assert.equal(error.status, 404);
        assert.match(error.message, /RestException: Process instance with id x does not exist/);
        return true;
      },
    );
  });

  test('treats an empty 204 as a successful write', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response(null, { status: 204 }));
    const client = new CamundaClient(CONFIG, undefined, { fetch });

    assert.equal(await client.post('task/1/complete', { body: { variables: {} } }), undefined);
  });

  test('returns raw text when asked (stacktraces, deployment resources)', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(new Response('java.lang.RuntimeException', { status: 200 }));
    const client = new CamundaClient(CONFIG, undefined, { fetch });

    assert.equal(await client.get('job/1/stacktrace', { raw: true }), 'java.lang.RuntimeException');
  });

  test('explains a transport failure instead of repeating "fetch failed"', async () => {
    const fetch: FetchLike = () =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('self-signed certificate in certificate chain'), {
            code: 'SELF_SIGNED_CERT_IN_CHAIN',
          }),
        }),
      );

    const client = new CamundaClient(CONFIG, undefined, { fetch });

    await assert.rejects(() => client.get('version'), /NODE_EXTRA_CA_CERTS/);
  });
});
