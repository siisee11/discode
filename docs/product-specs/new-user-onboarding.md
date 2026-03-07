# New User Onboarding

Status: active
Audience: contributors changing onboarding, setup docs, or first-run defaults
Update when: prerequisites, onboarding prompts, or post-onboarding state change

## Goal

Help a new user get from install to a working remote-controlled agent session with the fewest manual steps possible.

## Current Product Behavior

1. The user installs Discode globally or from source.
2. The user runs `discode onboard` to save credentials and choose defaults.
3. The user runs `discode new` inside a project directory.
4. Discode ensures the daemon, provisions a channel mapping, starts an agent session, and attaches locally.

## Dependencies

- a supported agent CLI must already be installed locally
- Discord is the primary documented onboarding path, with Slack as an alternative integration
- onboarding writes persisted config in `~/.discode/config.json`

## Canonical References

- User-facing setup detail: [`../DISCORD_SETUP.md`](../DISCORD_SETUP.md), [`../SLACK_SETUP.md`](../SLACK_SETUP.md)
- Architecture and entrypoints: [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)
- Local development variants: [`../../DEVELOPMENT.md`](../../DEVELOPMENT.md)
