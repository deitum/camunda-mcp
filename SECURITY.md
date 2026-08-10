# Security policy

## Supported versions

Security fixes are released for the latest published version only.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisory form](https://github.com/deitum/camunda-mcp/security/advisories/new)
rather than opening a public issue. We aim to acknowledge reports within a few working days.

## What this server can do to your engine

Two things are worth understanding before pointing it at anything that matters.

**`CAMUNDA_ALLOW_WRITE` hands an LLM the write API.** With it on, the model can start and delete
process instances, complete user tasks, modify a running instance, set variables, correlate
messages and resolve incidents. Those tools are not registered at all while the flag is off, which
is the only reliable control — a model cannot be instructed out of using a tool it can see. Turn it
on deliberately, and prefer an engine user whose Camunda authorizations are scoped to what the task
needs.

**`camunda_get` is an escape hatch.** It performs any `GET` against the engine REST API by path, so
it reaches endpoints no dedicated tool exposes. It cannot write, but it can read anything the
configured credentials can read.

Beyond that: the tool results are engine data, and engine data is untrusted input to whatever model
consumes it — variable values, incident messages and BPMN documentation all come from your
processes and may say anything.

## Credentials

Credentials arrive through the environment and are held in memory for the life of the process.
Nothing is written to disk and nothing is logged: the startup banner names the mode and the user,
never a secret or a token. `NODE_TLS_REJECT_UNAUTHORIZED=0`, mentioned in the README as a way past
an untrusted certificate chain, disables certificate verification for the whole process — prefer
`NODE_EXTRA_CA_CERTS` wherever you can.
