# Contributing

Thanks for taking the time. Bug reports, engine deployments this does not fit yet, and tools that
answer a real question are all welcome.

## Getting set up

```bash
npm install
npm run verify
```

`verify` is exactly what CI runs: lint → format → types → tests → build → packaging checks. Node 20
or newer (`.nvmrc` pins 22 for development; CI also runs 20 and 24).

| Command                 | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| `npm test`              | vitest, no network — every engine call goes through a stub |
| `npm run test:watch`    | the same in watch mode                                     |
| `npm run test:coverage` | coverage, with the thresholds CI enforces                  |
| `npm run build`         | `tsc` → `dist` (CommonJS, so `npx` can run `dist/cli.js`)  |
| `npm run inspector`     | build, then drive the server with the MCP inspector        |
| `npm run lint:fix`      | eslint --fix                                               |
| `npm run format`        | prettier --write                                           |

## How the code is arranged

```
src/
  cli.ts               stdio entry point (the bin)
  index.ts             library entry point
  server.ts            builds the McpServer and registers the tool halves
  config.ts            environment → CamundaConfig, and the auth-mode rules
  auth.ts              OAuth token providers (grant, cache, refresh)
  client.ts            typed wrapper over the engine REST API
  format.ts            projection, truncation, variable envelopes
  errors.ts            unfolds the cause chain fetch hides
  camunda.types.ts     shared types
  camunda.constants.ts limits, field lists, defaults
  tools/
    read-tools.ts      the 17 tools that only look
    write-tools.ts     the 8 tools CAMUNDA_ALLOW_WRITE turns on
    tool-kit.ts        shared argument fragments and the result wrapper
```

Tests sit next to what they test (`client.ts` ↔ `client.test.ts`).

## House rules

- **Nothing on stdout but protocol frames.** The transport is stdio; every diagnostic goes to
  stderr. `scripts/smoke.mjs` fails the build if that slips.
- **A tool result is trimmed before it is returned.** Engine pages are large and the model pays for
  every row; project rows down to useful fields and respect the caps in `camunda.constants.ts`.
- **A failing tool returns `isError`, it does not throw.** A model should be free to try a different
  filter rather than lose the turn.
- **Write tools are gated by registration**, not by wording in a description.
- **Error messages name the variable to change.** "Check CAMUNDA_BASE_URL" is worth more than the
  status code it replaces; the two failure modes worth this care are a wrong base URL and a token
  sent in the wrong position.
- Constants live in `camunda.constants.ts`, types in `camunda.types.ts`.

## Adding a tool

1. Register it in `tools/read-tools.ts` or `tools/write-tools.ts`, describing every argument with
   `.describe()` — that text is what the model reads.
2. Wrap the body in `run()` from `tools/tool-kit.ts` so failures come back as `isError`.
3. Project the response (`project()` in `format.ts`), adding a field list to
   `camunda.constants.ts` if there is a new shape.
4. Cover it in `server.test.ts` through the in-memory MCP client, and add it to the README table.

## Pull requests

- Include a changeset (`npm run changeset`) unless the change is docs-only or internal tooling. It
  is what versions and publishes the package.
- Keep `npm run verify` green.
- New behaviour needs a test; a bug fix needs the test that would have caught it.
