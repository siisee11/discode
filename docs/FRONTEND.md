# Frontend Guide

This is the canonical starting point for user-facing UI work in this repository.

Scope:
- `site/**` landing page and published docs site
- TUI user-facing behavior when the change is primarily UX-driven

Read next:
- [product-specs/index.md](/Users/dev/git/discode/docs/product-specs/index.md)
- [DESIGN.md](/Users/dev/git/discode/docs/DESIGN.md)
- [references/release-runbook.md](/Users/dev/git/discode/docs/references/release-runbook.md)

Operational rules:

- If `site/**` changes, deploy with `npm run pages:deploy`.
- Release work that changes the landing page must update the `new` copy in `site/index.html` to match the latest release.
- User-facing site docs are not the canonical maintainer source of truth; repo docs under `docs/` are.

Update this file when:
- Frontend surfaces or deployment responsibilities change
- The site/TUI split becomes materially different
