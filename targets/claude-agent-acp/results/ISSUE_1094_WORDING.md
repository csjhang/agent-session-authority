# Draft wording for Claire - issue #1094

## Proposed update

The live claude-agent-acp 0.75.1 effect-boundary run now demonstrates A: after restart, session load replays the prior Write at seq 31, 37, 45-49. The replay keeps the same toolCallId, so it is history replay, not a new execution.
The old generation-1 grant is seq 23. We did not observe that grant authorizing a new-generation request, so B remains untested and unknown.

The run demonstrates a separate fresh post-restart Write with a new toolCallId and a new approval request and grant at seq 58-63, followed by a controlled filesystem receipt matching requested path and content: native tool response seq 65, completion seq 66, and direct file read.
That is C for an explicitly authorized new action, not C for stale approval reuse. Prompt timeouts at seq 30 and 67 are unknown on their own and were not used as effect evidence.

live_capped_ok and live_effect_ok are collection statuses, not proof of a defect or safety. The evidence supports history replay plus a fresh authorized effect, but is insufficient to conclude stale-approval vulnerability or safety.
The next minimal experiment must carry an old approval across restart and test it against a new request with an independent effect receipt.

This is a draft only; do not post automatically.
