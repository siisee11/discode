# Agent Bridge Spec

Audience:
- Contributors changing message flow, hook handling, or file delivery

Canonical scope:
- Discord/Slack message ingress
- Agent output delivery back to messaging channels
- Attachment handling and path-scoped file upload behavior

## Expected Behavior

- Messages from mapped channels should route to the correct project instance and runtime window.
- Attachments should be downloaded into project-scoped storage and passed to the agent in an explicit, inspectable form.
- Agent output should return through the daemon hook path and preserve enough context for operators to follow the conversation remotely.
- File upload flows must validate that file paths stay within the intended project boundary before posting to messaging platforms.
- Delivery status should remain observable through the pending-message lifecycle.

## Related Code

- `src/bridge/message-router.ts`
- `src/bridge/hook-server.ts`
- `src/bridge/pending-message-tracker.ts`
- `src/{discord,slack,messaging}/**`

Update this spec when messaging semantics or file-handling behavior changes.
