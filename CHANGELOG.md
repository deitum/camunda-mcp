# @deitum/camunda-mcp

## 0.2.0

### Minor Changes

- cf2430c: First public release: an MCP server for Camunda 7 covering BPMN and DMN definitions, running
  instances, variables, user tasks, incidents, history and DMN evaluation, with the write half gated
  behind `CAMUNDA_ALLOW_WRITE`.

  Authentication covers four schemes — none, HTTP Basic, a ready-made token and an OAuth2/OIDC token
  endpoint (password or client-credentials grant) — and the token travels either as
  `Authorization: Bearer` (the default) or in a cookie, for engines published behind a filter that
  reads it there (`CAMUNDA_AUTH_TRANSPORT`).
