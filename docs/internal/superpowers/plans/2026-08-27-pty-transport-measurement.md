# PTY transport measurement implementation plan

Issue: `POD-2957`
Spec: `docs/internal/superpowers/specs/2026-08-27-pty-transport-measurement-design.md`
Runs alongside: `POD-2953`; final comparison depends on `POD-2954`, `POD-2955`, and `POD-2956`

## Ownership

This worker owns only new benchmark/harness, dedicated performance-lane configuration, and ephemeral
result/report artifacts. It may add one narrowly named package script and dedicated test configuration
when required. It must not edit production client, server, daemon, PTY, protocol, or transport test
files owned by the implementation workers. Mail the parent issue if a missing production counter is
needed; the owner adds it.

## Tasks

1. Add a reproducible PTY transport benchmark/performance command admitted through the repository's
   heavy-lane machinery. Keep intentionally amplified benchmarks out of generic unit collection.
2. Implement codec/representation cases for keystroke, 4 KiB, 16 KiB, 64 KiB, and 1 MiB payloads over
   ASCII, Unicode, and escape-heavy data. Record base64, JSON, envelope, and raw sizes plus elapsed time
   and an allocation/heap proxy.
3. Add harness scenarios for one/four viewers, replay, compression, and slow-client/backpressure where
   they can be measured hermetically without modifying production code.
4. Capture a baseline on the named parent SHA before binary implementation. Save raw outputs and a
   concise baseline report inside this issue worktree, attach them to POD-2957, and do not commit
   machine-specific numbers.
5. After all implementation children integrate, rebase/resume against the final parent tip and run the
   same harness under the same host/runtime conditions. Exercise all-in-one, remote daemon, mixed
   versions, single-key/large-paste, and one smallest real browser input-to-paint interaction.
6. Publish and attach a final report naming base/candidate SHAs, commands, environment, sample counts,
   variability, raw results, regressions, gains, and unsupported cells. Do not tune production settings.

## Validation and handoff

For the harness implementation, run `bun run test` once after edits, then the new dedicated performance
command once under its heavy-lane admission. Do not overlap heavy commands from this or sibling
sessions. The final real browser interaction follows `docs/agents/driving-podium.md` and is driven only
once at the affected boundary.

Commit harness code with trailer `Podium-Issue: POD-2957`. Do not commit machine-specific reports, merge,
or deploy. Update the child issue and mail the parent issue at baseline-ready and final-report-ready
checkpoints.
