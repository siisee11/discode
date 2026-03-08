# Generated Data Schema Notes

Canonical for: generated or mechanically derived persistence/reference artifacts
Audience: contributors looking for database or persisted-shape documentation
Update when: a generated schema is added or persisted data contracts materially change

Current state: this repository does not use a relational database schema.

Persisted shapes that matter today:

- `~/.discode/config.json`
- `~/.discode/state.json`
- runtime control and stream payloads documented in [`../references/RUNTIME_WINDOW_API.md`](../references/RUNTIME_WINDOW_API.md)
- daemon compatibility expectations documented in [`../references/DAEMON_RUST_MIGRATION.md`](../references/DAEMON_RUST_MIGRATION.md)

If the repository gains generated schemas later, add them here instead of burying them inside ad hoc notes.
