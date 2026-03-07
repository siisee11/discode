# Core Beliefs

Status: active
Audience: anyone making design or implementation tradeoffs
Verified against code: 2026-03-07
Update when: these principles stop matching how the repository actually works

## Product Beliefs

1. Local-first execution beats hosted orchestration.
   The core flows assume agents run on the developer machine and expose only the collaboration surface remotely.

2. Chat is the control surface, not a secondary notification channel.
   Discord and Slack are part of the product workflow, not just alert sinks.

3. Persistent sessions matter.
   The daemon and runtime layers are designed around long-lived project instances rather than one-shot commands.

## Engineering Beliefs

1. Keep one stable daemon surface and hide implementation swaps behind contracts.
   The repository already treats runtime and daemon protocols as compatibility boundaries.

2. Prefer explicit adapters over agent-specific branching scattered across the codebase.
   Agent integrations are separated into adapters, policies, and hook installers.

3. Migrations should preserve operating behavior before optimizing internals.
   The PTY Rust and Rust-daemon documents both codify compatibility-first migration steps.

4. Durable reasoning belongs in checked-in docs and plans, not only in chat history.
   That is why architecture maps, plans, and operational docs are part of the repository.
