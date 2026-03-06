# Runtime Sessions Spec

Audience:
- Contributors changing daemon lifecycle, runtime modes, session restore, or TUI attach flows

Canonical scope:
- Global daemon ownership
- Runtime mode selection
- Session creation, restore, attach, and stop behavior

## Expected Behavior

- One global daemon should coordinate project/runtime state and messaging integrations.
- Runtime mode selection should remain explicit and predictable for `tmux` and `pty-rust`.
- Session lifecycle commands such as `new`, `attach`, `stop`, and daemon operations should map cleanly onto the active runtime implementation.
- Persisted state should be sufficient for daemon bootstrap and runtime recovery.
- User-facing attach flows should preserve the expectation that the local terminal remains the authoritative interactive surface.

## Related Code

- `src/daemon-entry.ts`
- `src/index.ts`
- `src/runtime/**`
- `src/state/**`
- `src/cli/commands/{new,attach,stop,daemon}.ts`

Update this spec when runtime ownership or session lifecycle behavior changes.
