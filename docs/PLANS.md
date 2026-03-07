# Plans Map

Canonical for: durable execution plans, progress tracking, and known technical debt
Audience: contributors doing multi-step implementation work
Update when: a task becomes complex enough to need a checked-in plan, or when plan status changes

Plan locations:

- Active execution plans: [`exec-plans/active/README.md`](exec-plans/active/README.md)
- Completed execution plans: [`exec-plans/completed/README.md`](exec-plans/completed/README.md)
- Known debt and follow-up work: [`exec-plans/tech-debt-tracker.md`](exec-plans/tech-debt-tracker.md)

Execution plan template:

- goal and scope
- background
- milestones
- current progress
- key decisions
- remaining issues or open questions
- links to related documents

Use a checked-in plan when:

- the work spans multiple subsystems
- the rollout needs durable checkpoints
- the repository should preserve the reasoning after the task ships
