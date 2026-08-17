---
'@deitum/camunda-mcp': minor
---

Add `CAMUNDA_SSL_VERIFY`: setting it to `false` stops verifying TLS certificates, for an engine
signed by a private root when adding that root to `NODE_EXTRA_CA_CERTS` is not an option. On by
default; the switch is process-wide (it sets `NODE_TLS_REJECT_UNAUTHORIZED=0`), so the startup
banner says `TLS verification OFF` while it is in effect.
