# Agent Harness Implementation Checklist

Use this checklist when adding or auditing an agent harness so it reaches parity with Claude Code and Grok where the underlying CLI supports it.

## Product Surface

- [ ] Add the harness to shared protocol/model enums and any persisted session/conversation schemas.
- [ ] Add labels, icons, badges, menu entries, settings controls, model selectors, and resume labels in web UI.
- [ ] Make the harness selectable from new-panel flows and superagent/harness-exec flows when supported.
- [ ] Define clear unsupported states instead of hiding capabilities silently.

## Launch And Lifecycle

- [ ] Implement CLI detection/help validation and launch command construction for fresh, resumed, one-shot, and model-selected runs.
- [ ] Preserve durable PTY behavior across spawn, reattach, resize, redraw, hibernate, resurrect, exit, and explicit kill.
- [ ] Capture the harness resume ref as soon as it is known and persist it on the server session.
- [ ] Avoid destructive process cleanup except for explicit user kill/reap actions.

## Transcript And Chat

- [ ] Normalize live structured transcript records into `TranscriptItem` user, assistant, system, tool-call, and tool-result items.
- [ ] Tail the live transcript on fresh sessions and resume/reattach paths; handle missing files, truncation, and bounded initial reads.
- [ ] Set `transcriptAvailable` through the normal append path and expose chat mode before first append for known transcript harnesses.
- [ ] Keep chat composer write-through behavior working with the native PTY input stream.
- [ ] Load historical transcript content through discovery `loadConversation()` and merge summaries into the unified conversation index.

## State Instrumentation

- [ ] Provide an `AgentStateProvider` or equivalent observer for session start, prompt submit, activity, tool activity, compaction, completion, failure, need-user, and session end signals.
- [ ] Seed boot state for fresh spawns and reattached survivors so idle sessions do not look active forever.
- [ ] Classify idle verdicts from transcript/history where possible: done, question, approval, or open todos.
- [ ] Stop observers and tails on exit, kill, close, and daemon shutdown without touching unrelated live sessions.

## Discovery And History

- [ ] Add a discovery provider with default roots, diagnostics, summary metadata, resume refs, related paths, and project/worktree attribution.
- [ ] Support agent-kind filtering and cached/background scans.
- [ ] Keep historical conversations searchable with consistent titles, timestamps, message counts, provider ids, and git metadata.

## Tests And Fixtures

- [ ] Cover launch command construction, CLI detection, protocol/schema changes, labels/selectors, and settings defaults.
- [ ] Cover transcript normalization, tailing/reset behavior, history loading, discovery scans, and unified index ingestion.
- [ ] Cover live state reducers/providers, boot-state seeding, resume refs, and cleanup paths.
- [ ] Cover web affordances for new-panel selection, chat/native mode, resume/hibernate UI, and diagnostics.
- [ ] Include fixtures for real on-disk session layouts and malformed/torn JSONL records.

## Verification

- [ ] Run focused package tests plus app/server/daemon tests touched by the harness.
- [ ] Run typecheck and lint/format checks used by the repo.
- [ ] Smoke-test the installed CLI help and a bounded safe invocation on the local machine when the CLI is available.
- [ ] Document any unsupported CLI capability, quota/login blocker, or follow-up needed.
