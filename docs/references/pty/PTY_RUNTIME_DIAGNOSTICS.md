# PTY Runtime Diagnostics Metrics

Canonical for: runtime-side counters used to debug VT parsing, PTY query handling, and frame streaming behavior
Audience: contributors diagnosing PTY runtime regressions or query/rendering edge cases
Status: active reference
Update when: runtime diagnostics counters, semantics, or test coverage change

`discode` exposes internal PTY runtime counters for debugging parser, query-response, and frame-streaming behavior.

Implementation:

- `src/runtime/vt-diagnostics.ts`

Primary counters:

1. `vt_partial_sequence_carry|kind=<escape|csi|osc>`
   Counts how often the VT parser carries an incomplete sequence across chunk boundaries.
2. `vt_unknown_escape|next=<char>`
   Tracks the next-character distribution for unsupported `ESC` sequences.
3. `vt_unknown_csi|final=<char>`
   Tracks the final-byte distribution for unsupported `CSI` sequences.
4. `pty_query_partial_carry|kind=<escape|csi|osc|apc>`
   Counts how often the query responder keeps an incomplete sequence in carry state.
5. `pty_query_response|kind=<...>`
   Counts query responses sent by kind, including DSR, OSC, and private-mode reports.
6. `stream_forced_flush`
   Counts forced flushes performed by the stream server.
7. `stream_coalesced_skip`
   Counts frame sends skipped by coalescing rules.
8. `stream_runtime_error`
   Counts `runtime_error` responses emitted after runtime buffer access failures.

Test coverage:

- `tests/runtime/vt-diagnostics.test.ts`
