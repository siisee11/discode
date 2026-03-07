# Frontend Map

Canonical for: user-facing UI surfaces in this repository
Audience: contributors touching the landing page, static docs site, or terminal UI
Update when: UI ownership, entrypoints, or deployment expectations change

Current frontend surfaces:

- Landing page: `site/index.html`
- Static docs site: `site/docs/**`
- Terminal UI: `bin/tui.tsx`

Use this routing:

- Product intent for onboarding and session UX: [`product-specs/index.md`](product-specs/index.md)
- Architecture of runtime attach and TUI integration: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Web deployment procedure: [`operations/web-deploy.md`](operations/web-deploy.md)

Current reality:

- the landing page is release-facing and must stay aligned with the latest shipped version
- the static docs site still links to several legacy flat docs paths
- the TUI is part of the runtime experience, not a separate web app
