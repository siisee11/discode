# Setup and Bootstrap

Canonical for: first-run setup/bootstrap entrypoint for contributors and agents
Audience: contributors or agents preparing a working Discode environment
Update when: prerequisites, first-run commands, or setup-routing targets change

Start here for setup/bootstrap guidance. This page is the canonical entrypoint; deeper setup docs should be opened from here instead of starting from scattered guides.

## Bootstrap Paths

### Release/Operator Path

Use this when running the published CLI package.

1. Install Discode (`npm install -g @siisee11/discode` or `bun add -g @siisee11/discode`).
2. Run onboarding (`discode onboard` for Discord, or `discode onboard --platform slack` for Slack).
3. Enter your project directory and start a session (`discode new` or `discode new <agent>`). The CLI now uses the Rust PTY runtime by default and does not require a tmux runtime setup.

### Source Contributor Path

Use this when iterating on repository code.

1. Install dependencies (`bun install`).
2. Run the CLI from source (`bun run tsx bin/discode.ts onboard`, then `bun run tsx bin/discode.ts new`).
3. If you launch via the repository wrapper (`./bin/discode`), it prefers source when `bin/discode.ts` is newer than checked-in `dist/bin/discode.js`; otherwise it uses the built `dist` entrypoint.
4. For source-vs-release workflow details, use [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md).

## Setup Routing

- Discord app/bot setup details: [`../references/DISCORD_SETUP.md`](../references/DISCORD_SETUP.md)
- Slack app setup details: [`../references/SLACK_SETUP.md`](../references/SLACK_SETUP.md)
- Product onboarding behavior: [`../product-specs/new-user-onboarding.md`](../product-specs/new-user-onboarding.md)
- Operational restart expectations after code changes: [`daemon-restart.md`](daemon-restart.md)
- CLI command reference and examples: [`../../README.md`](../../README.md)
