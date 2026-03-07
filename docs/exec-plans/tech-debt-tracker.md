# Tech Debt Tracker

Canonical for: known follow-up work that should remain visible after code ships
Audience: maintainers and contributors planning cleanup or reliability work
Update when: debt is added, reprioritized, or paid down

| ID | Debt | Why it exists | Current impact | Next step |
| --- | --- | --- | --- | --- |
| DOC-001 | Legacy flat docs still coexist with the new indexed system | external links and historical references still point at old paths | discoverability is better, but canonical ownership is not fully normalized | gradually move or replace legacy flat docs with indexed homes |
| DOC-002 | Static site pages still link to legacy docs paths | site content was authored against the older docs layout | readers can miss the new canonical indexes | update site docs pages to point to the new map documents during the next site refresh |
| DOC-003 | `docs/ARCHITECTURE.md` is now only a compatibility pointer | README and older references used the old location | duplicate architecture entrypoints can confuse readers | remove the compatibility file after downstream links are updated |
| OPS-001 | Release process details are split between English operational docs and a Korean packaging guide | release knowledge accumulated incrementally | maintainers need to cross-reference multiple docs | unify the detailed release checklist under `docs/operations/` while keeping translated docs aligned |
| PLAN-001 | Several historical execution plans still live at repo root or flat docs paths | they predate the new `exec-plans/` structure | plans are discoverable only through indexes | move or supersede these files when their consumers are updated |
