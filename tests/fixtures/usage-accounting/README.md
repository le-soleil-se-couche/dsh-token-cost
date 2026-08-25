# DSH usage-accounting public fixture

This fixture is generated entirely from placeholder values. Its session data
contains no transcript, prompt, response, tool payload, query, credential
metadata, local path, real identifier, or real timestamp.

The JSONL files are minimal projection inputs, not replayable `SessionStore`
transcripts. Turn lifecycle and surface-message payloads are intentionally
omitted because the accounting fold does not consume them and they would add
content-shaped fields to a fixture whose purpose is structural metering.

The two session logs exercise four independent accounting rules:

1. A final `assistant/message` usage replaces the usage chunk from the same
   request attempt.
2. A failed attempt with non-zero usage remains billable when the same
   `(turn, step)` is retried.
3. `compaction/summary.usage` is an independent model call and is added.
4. A forked child owns only events whose `seq >= seedLength`; its inherited
   prefix is not counted again during cross-session aggregation.

An additional failed request with no usage sample confirms that the fold does
not invent a zero-valued billing record.

A synthetic merge-extended finish kind carrying `failure` is followed by its
assistant message. Current AgentLoop only closes `error | aborted`; treating
every `failure` field as a boundary in the downstream fold would double-count
this counterexample. This keeps the hardening question raised in
`deepseek-ai/deepseek-harness` discussion #1886 explicit while it is reviewed.

`expected.json` contains only hand-computed totals for the synthetic events.
The real reconciliation remains outside this public fixture; aggregate numbers
belong in their source-backed discussion with their evidence boundary.

Run the fixture and privacy checks:

```bash
pnpm vitest run tests/usage-accounting-fixture.test.ts
```

The fixture intentionally cannot reproduce title, Web Search, or unattributed
official calls as usage-bearing DSH events: those events are exactly what the
upstream telemetry proposal needs to add. Publishing a fabricated usage value
for them would hide the gap instead of demonstrating it.
