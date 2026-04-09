# Frontend Map

Canonical for: user-facing UI surfaces in this repository
Audience: contributors touching the landing page, static docs site, or terminal UI
Update when: UI ownership, entrypoints, or deployment expectations change

Current frontend surfaces:

- Landing page: `site/index.html`
- Static docs site: `site/docs/**`
- Native terminal attach UI: `runtime-client-rs/src/main.rs`

Use this routing:

- Product intent for onboarding and session UX: [`product-specs/index.md`](product-specs/index.md)
- Architecture of runtime attach and TUI integration: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Worktree browser harness: [`operations/harness.md`](operations/harness.md)
- Web deployment procedure: [`operations/web-deploy.md`](operations/web-deploy.md)

Current reality:

- the landing page is release-facing and must stay aligned with the latest shipped version
- the landing page and docs site now have a worktree-scoped harness boot path for agent-browser validation
- the static docs site still links to several legacy flat docs paths
- the primary local terminal UI is the Rust native attach client
