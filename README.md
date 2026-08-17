# @deitum/camunda-mcp

An [MCP](https://modelcontextprotocol.io) server for **Camunda 7**: BPMN and DMN definitions,
running instances, variables, user tasks, incidents, history, DMN evaluation — and, behind a flag,
the operations that change the engine.

It talks to the engine's REST API, so it works with a standalone distribution, a Spring Boot
application with `camunda-bpm-spring-boot-starter-rest`, and an engine published behind a reverse
proxy alike. Authentication covers the four schemes those deployments actually use: none, HTTP
Basic, a ready-made token, and an OAuth2 / OIDC token endpoint — with the token sent either as
`Authorization: Bearer` or in a cookie.

```bash
npx @deitum/camunda-mcp
```

It speaks MCP over stdio and is configured entirely through environment variables.

## Setting it up in a client

**Claude Desktop** (`claude_desktop_config.json`), **Cursor**, **Windsurf** and anything else that
reads the same shape:

```json
{
  "mcpServers": {
    "camunda": {
      "command": "npx",
      "args": ["-y", "@deitum/camunda-mcp"],
      "env": {
        "CAMUNDA_BASE_URL": "http://localhost:8080/engine-rest",
        "CAMUNDA_USERNAME": "demo",
        "CAMUNDA_PASSWORD": "demo"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add camunda \
  --env CAMUNDA_BASE_URL=http://localhost:8080/engine-rest \
  --env CAMUNDA_USERNAME=demo \
  --env CAMUNDA_PASSWORD=demo \
  -- npx -y @deitum/camunda-mcp
```

**VS Code** (`.mcp.json` / `.vscode/mcp.json`), where the password is prompted for rather than
written down:

```json
{
  "inputs": [
    {
      "id": "camunda-password",
      "type": "promptString",
      "description": "Camunda password",
      "password": true
    }
  ],
  "servers": {
    "camunda": {
      "command": "npx",
      "args": ["-y", "@deitum/camunda-mcp"],
      "env": {
        "CAMUNDA_BASE_URL": "http://localhost:8080/engine-rest",
        "CAMUNDA_USERNAME": "demo",
        "CAMUNDA_PASSWORD": "${input:camunda-password}"
      }
    }
  }
}
```

A variable left as a literal `${input:NAME}` counts as unset, so a placeholder that was never
filled in reads as a missing value rather than being sent to the engine as a username.

## Configuration

| Variable                 | Required | Meaning                                                                    |
| ------------------------ | -------- | -------------------------------------------------------------------------- |
| `CAMUNDA_BASE_URL`       | yes      | Engine REST root ([which one?](#which-base-url)).                          |
| `CAMUNDA_AUTH`           | –        | `none` \| `basic` \| `bearer` \| `oauth`. Inferred when omitted.           |
| `CAMUNDA_USERNAME`       | –        | User, for Basic auth or the OAuth password grant.                          |
| `CAMUNDA_PASSWORD`       | –        | Its password.                                                              |
| `CAMUNDA_TOKEN`          | –        | A ready-made token to send as-is (`bearer`).                               |
| `CAMUNDA_TOKEN_URL`      | –        | OAuth2 / OIDC token endpoint (`oauth`).                                    |
| `CAMUNDA_CLIENT_ID`      | –        | OAuth client.                                                              |
| `CAMUNDA_CLIENT_SECRET`  | –        | Only for a confidential client.                                            |
| `CAMUNDA_GRANT_TYPE`     | –        | `password` \| `client_credentials`. Inferred from whether a user is given. |
| `CAMUNDA_SCOPE`          | –        | Scope to request, if the provider needs one.                               |
| `CAMUNDA_AUTH_TRANSPORT` | –        | `header` (default) \| `cookie` — how the token reaches the engine.         |
| `CAMUNDA_COOKIE_NAME`    | –        | Cookie to put it in when the transport is `cookie` (default `JWT`).        |
| `CAMUNDA_ALLOW_WRITE`    | –        | `true` registers the tools that change the engine. Default off.            |
| `CAMUNDA_SSL_VERIFY`     | –        | `false` stops verifying TLS certificates ([why](#tls)). Default on.        |
| `CAMUNDA_MAX_RESULTS`    | –        | Default page size (default 20, hard cap 100).                              |
| `CAMUNDA_TIMEOUT_MS`     | –        | Per-request budget (default 30000).                                        |

The two flags read `true`/`1`/`yes` and `false`/`0`/`no`; anything else leaves the default in
place, so a typo can only fail closed — writes off, certificates verified.

## Authentication

Set only the variables your engine needs; the mode follows from them, and `CAMUNDA_AUTH` is there
for the rare case where the guess is wrong.

**None** — a local distribution with the auth filter switched off:

```bash
CAMUNDA_BASE_URL=http://localhost:8080/engine-rest
```

**HTTP Basic** — what Camunda's own `ProcessEngineAuthenticationFilter` speaks, and what
`camunda-bpm-platform:run` ships with:

```bash
CAMUNDA_USERNAME=demo
CAMUNDA_PASSWORD=demo
```

**A ready-made token** — one you already have from somewhere else:

```bash
CAMUNDA_TOKEN=eyJhbGciOi…
```

**OAuth2 / OIDC** — this server fetches tokens itself and renews them as they expire, sharing one
grant across concurrent tool calls and using the refresh token when the provider issues one:

```bash
# password grant
CAMUNDA_TOKEN_URL=https://idp.example/realms/demo/protocol/openid-connect/token
CAMUNDA_CLIENT_ID=camunda-client
CAMUNDA_CLIENT_SECRET=…        # confidential clients only
CAMUNDA_USERNAME=user
CAMUNDA_PASSWORD=…

# client-credentials grant — drop the user, that is the whole difference
CAMUNDA_TOKEN_URL=https://idp.example/realms/demo/protocol/openid-connect/token
CAMUNDA_CLIENT_ID=camunda-service
CAMUNDA_CLIENT_SECRET=…
```

Credentials are all-or-nothing per mode: a half-filled set fails at startup, naming what is
missing, rather than turning every tool call into the engine's login page.

### Bearer header or cookie?

By default a token travels as `Authorization: Bearer <token>`, which is what a Camunda engine
expects. Some deployments publish the engine behind a proxy or an OIDC filter that reads the token
from a **cookie** and ignores the `Authorization` header entirely — for those:

```bash
CAMUNDA_AUTH_TRANSPORT=cookie
CAMUNDA_COOKIE_NAME=JWT        # the default; change it if the filter uses another name
```

When the transport is `cookie` no `Authorization` header is sent at all. The symptom of getting
this wrong is a `302` to the identity provider while the same token works in the other position —
the error message says exactly that, and which variable to flip.

### Which base URL?

- standalone distribution or Spring Boot starter → `https://host/engine-rest`
- deployment where only the webapp is exposed → `https://host/camunda/api/engine/engine/default`

Both serve the same API. Getting it wrong is the common failure and does not look like one — the
front-end that owns the wrong path tends to answer `200 text/html` — so the server checks for that
and says which URLs to try.

### TLS

An internally hosted engine is often signed by a private root that Node does not ship, so the first
call fails with `SELF_SIGNED_CERT_IN_CHAIN` while `curl` against the same URL works (it uses the
system store). The error message says as much rather than repeating `fetch failed`.

Two ways out, in order of preference:

```bash
NODE_EXTRA_CA_CERTS=/path/to/internal-root.pem   # keeps verification, just teaches Node the root
CAMUNDA_SSL_VERIFY=false                         # verifies nothing at all
```

`CAMUNDA_SSL_VERIFY=false` sets `NODE_TLS_REJECT_UNAUTHORIZED=0`, which is process-wide: Node's
`fetch` takes TLS settings from the process, not per connection, so it covers the token endpoint
too and there is no way to scope it to the engine alone. It leaves the connection open to
interception — use it against a development engine, and add the root certificate for anything else.
The startup banner on stderr says `TLS verification OFF` while it is in effect.

## Tools

Read-only, always registered:

| Tool                                     | What it answers                                         |
| ---------------------------------------- | ------------------------------------------------------- |
| `camunda_list_decision_definitions`      | deployed DMN decisions (Cockpit's «Decisions»)          |
| `camunda_get_decision_dmn`               | the DMN XML — the decision table itself                 |
| `camunda_evaluate_decision`              | runs a decision against inputs, returns the output rows |
| `camunda_list_decision_instances`        | evaluation history with inputs/outputs                  |
| `camunda_list_process_definitions`       | deployed BPMN processes                                 |
| `camunda_get_process_bpmn`               | the BPMN XML (source of activity ids)                   |
| `camunda_list_process_instances`         | running instances, by key or business key               |
| `camunda_get_activity_instances`         | where an instance is sitting right now                  |
| `camunda_list_variables`                 | an instance's variables, unwrapped                      |
| `camunda_list_tasks`                     | open user tasks                                         |
| `camunda_list_incidents`                 | open incidents                                          |
| `camunda_get_job_stacktrace`             | the exception behind a failed job                       |
| `camunda_list_history_process_instances` | finished instances                                      |
| `camunda_list_history_activities`        | one instance's audit trail                              |
| `camunda_list_deployments`               | deployments, newest first                               |
| `camunda_get_deployment_resource`        | a deployment's files, or one file's content             |
| `camunda_get`                            | escape hatch: any engine `GET` by path                  |

Registered only with `CAMUNDA_ALLOW_WRITE=true`: `camunda_start_process_instance`,
`camunda_complete_task`, `camunda_modify_process_instance`, `camunda_set_variables`,
`camunda_send_message`, `camunda_set_job_retries`, `camunda_resolve_incident`,
`camunda_delete_process_instance`.

The write half is _not registered_ rather than merely discouraged: a model cannot be told "do not
touch" reliably, but it cannot call a tool it was never shown.

`camunda_evaluate_decision` is deliberately in the read half: it changes no engine state (only a
history entry) and it is much of the reason to point this at an engine's decision tables.

Variables are passed as plain JSON (`{"amount": 100}`) and typed automatically; pass the engine's
own envelope (`{"amount": {"value": "100", "type": "String"}}`) when you need an exact type.

Results are trimmed on the way back: list tools project each row down to the fields worth reading,
`maxResults` is capped at 100, XML at 40 000 characters and any single result at 60 000 — an engine
page of a few thousand rows would otherwise land in the model's context whole.

## Troubleshooting

| Symptom                                 | What it means                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `302` to the identity provider          | The token was not accepted in the position it was sent — try the other `CAMUNDA_AUTH_TRANSPORT`. |
| `returned HTML, not engine JSON`        | `CAMUNDA_BASE_URL` points at a front-end, not the engine REST root.                              |
| `SELF_SIGNED_CERT_IN_CHAIN`             | Node does not trust the chain; see [TLS](#tls).                                                  |
| `Incomplete <mode> credentials`         | A half-filled set — the message names the missing variables.                                     |
| `Engine rejected the credentials (401)` | The engine understood the credentials and refused them.                                          |

Checking a deployment by hand, which separates a bad URL from a bad token:

```bash
curl -s -u demo:demo "http://localhost:8080/engine-rest/decision-definition?maxResults=5"
```

A JSON array means the base URL and the credentials are both right. HTML means the base URL is
wrong. A `302` to an identity provider means the credentials were not accepted in that position.

## Using it as a library

The stdio binary is the point, but the server is exported too — for a custom transport or a test
harness:

```ts
import { createCamundaServer, loadConfig } from '@deitum/camunda-mcp';

const server = createCamundaServer(loadConfig(process.env));
await server.connect(myTransport);
```

## Development

```bash
npm install
npm run verify        # lint, format, types, tests, build, packaging
npm test              # vitest, no network
npm run inspector     # build, then drive it with the MCP inspector
```

Against a throwaway engine:

```bash
docker run --rm -p 8080:8080 camunda/camunda-bpm-platform:run-latest
CAMUNDA_BASE_URL=http://localhost:8080/engine-rest \
  CAMUNDA_USERNAME=demo CAMUNDA_PASSWORD=demo \
  npx @modelcontextprotocol/inspector node dist/cli.js
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

[MIT](./LICENSE).
