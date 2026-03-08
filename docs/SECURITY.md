# Security Map

Canonical for: repository security model, secret handling, and trust boundaries
Audience: contributors working on config, hooks, file transfer, release automation, or external integrations
Update when: secrets handling, network exposure, file validation, or packaging trust assumptions change

Current security model:

- bot tokens and local config live outside the repo in `~/.discode/config.json`
- daemon control and hook endpoints are loopback-only interfaces
- file uploads from agents are validated against project scope before being forwarded
- npm publishing requires authenticated maintainer credentials and should use automation tokens

Primary references:

- Discord setup: [`references/DISCORD_SETUP.md`](references/DISCORD_SETUP.md)
- Slack setup: [`references/SLACK_SETUP.md`](references/SLACK_SETUP.md)
- Release procedure: [`operations/release.md`](operations/release.md)
- Runtime and hook contracts: [`references/index.md`](references/index.md)

Do not store secrets in checked-in docs, plans, or release notes.
