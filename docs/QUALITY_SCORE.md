# Quality Score

This document defines the baseline quality bar for repository changes.

Default expectations:

- Behavior is covered by focused tests when code paths change.
- `npm run typecheck` remains clean for the touched area.
- The canonical documentation for the changed behavior is updated in the same change.
- Operational workflows are verified when release, runtime, or deploy behavior changes.

Preferred evidence:

- Test output or a clear explanation of why a check could not run
- File-level doc updates linked from the relevant index
- Explicit notes when residual risk remains

Update this file when the repository's default verification bar changes.
