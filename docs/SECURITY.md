# Security

This document captures the main security boundaries for the repository.

Key rules:

- Secrets such as bot tokens belong in local config, never in the repository.
- Loopback daemon endpoints and local runtime control are trusted local surfaces and should not silently widen to remote exposure.
- File send and attachment flows must keep path validation scoped to the project boundary.
- Security-sensitive behavior should stay reflected in code, tests, and docs together.

Related docs:
- [references/daemon-operations.md](/Users/dev/git/discode/docs/references/daemon-operations.md)
- [product-specs/agent-bridge.md](/Users/dev/git/discode/docs/product-specs/agent-bridge.md)

Update this file when auth, token storage, network exposure, or file-boundary behavior changes.
