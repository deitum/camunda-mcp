# @deitum/camunda-mcp

## 0.3.0

### Minor Changes

- 76187bb: Add `CAMUNDA_SSL_VERIFY`: setting it to `false` stops verifying TLS certificates, for an engine
  signed by a private root when adding that root to `NODE_EXTRA_CA_CERTS` is not an option. On by
  default; the switch is process-wide (it sets `NODE_TLS_REJECT_UNAUTHORIZED=0`), so the startup
  banner says `TLS verification OFF` while it is in effect.

## 0.2.0

### Minor Changes

- cf2430c: First public release: an MCP server for Camunda 7 covering BPMN and DMN definitions, running
  instances, variables, user tasks, incidents, history and DMN evaluation, with the write half gated
  behind `CAMUNDA_ALLOW_WRITE`.

  Authentication covers four schemes — none, HTTP Basic, a ready-made token and an OAuth2/OIDC token
  endpoint (password or client-credentials grant) — and the token travels either as
  `Authorization: Bearer` (the default) or in a cookie, for engines published behind a filter that
  reads it there (`CAMUNDA_AUTH_TRANSPORT`).
