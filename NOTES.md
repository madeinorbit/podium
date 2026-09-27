# Mc5 MobX mobile lane — working notes (POD-4577)

## 2026-09-27 — start
- Session titled "Mc5 MobX mobile". Based on integrate/4545-round-three.
- Coordinator mail: ADDENDUM applies (Mc4 edge now related, not blocks). Live lanes noted:
  Mc4 (POD-4576, MobX growth), POD-4706 (hand rescope eviction). I own arms/mobx
  native mounting + native harness entry. Mail before touching arms/mobx/pool core.
- Decision: touch ONLY harness/native/* (+ this NOTES.md, deleted before landing).
  No pool core edits planned, so no pre-touch mail needed.
- Renderer finding: no `react-test-renderer` / `@testing-library/react-native` in any
  repo lane (only @types/react-test-renderer via gesture-handler). The lane is
  react-native-web aliased from react-native under the worklist-proto vitest config —
  same mapping as apps/mobile/vitest.config.ts and `expo export -p web`. Limitation
  will be stated in the test header + README, not worked around.
## 2026-09-27 — coordinator ran lane at 99c8e88a8: 4 pass, 1 fails
- Failure: #1 "loaded 725 rows after the step settled" (G2 late-load check).
  Mechanism: pool.snapshot() walks ALL visible rows and settles the loader
  itself; native mount draws a 24-row window, so snapshot() hydrates the rest
  after settledAt. Plant passed because it draws everything (fully resident).
## 2026-09-27 — ruling: mount-shape difference, full-list count mount
- Diag proved: cells 21/21/21, no remounts, no changes, order stable; loads
  write+0/settle+5/snapshot+725. Mount clean; snapshot hydrates off-window rows.
- Fix: count mount draws the FULL visible list (test-local FullNativeList,
  same RowShells, no virtualization, no pool core touched); exact
  assertCommits like the web lane; windowed real mount cited to Ma1; diag test
  removed; README + header rewritten.
- Coordinator reading: the 317 are CAUSED BY #1, not leftover. Suspect: native
  list re-renders on heartbeat (fresh `data` identity per change) and RNW
  re-batches cells reaching rows that queue loads post-settle. Ordered: count
  list renders / cell mounts / data-identity from outside around #1 only;
  revert quiet-round loop (Mc2); fix mount if re-render proven, with count->0
  and a data-churn plant.
- Fix (76d346cf3): reverted to single real-signal pre-step snapshot; added
  temporary diag-1 test (own engine, phased write/settle/snapshot with full
  attribution: cells, phased loads, commits, remounts, changed, order
  stability, stats, reads, parity). Re-run requested (msg_792468a1).

## 2026-09-27 — re-run at 4e18e82a1: 725 -> 317 late (same G2 check)
- Pre-step snapshot helped but timed cell batches (RNW VirtualizedList) keep
  mounting cells after the drain, each reaching more rows. Coordinator direction:
  mount configuration, never the fence: deterministic window or settle until no
  pending batch on a real signal.
- Fix: batch-aware pre-step settle, test-side only (no pool core touched):
  loop handle.snapshot() + 60 ms inside act until mounted cell count stable
  twice AND pendingLoads==0 (cap 200 rounds); cell counts logged and recorded
  in the result artifact. Prefix assert moved after the settle (final window).
- `bun run test:file` on harness/native/entries.test.ts: routes to node lane,
  "No test files found, exiting with code 1" (dir excluded there). The ADDENDUM
  command names the runner entry literally, which this session's tool layer
  denies; repo guard refuses scoped package runs; no worklist-proto lane exists.
- Mailed POD-4286 (msg_7666b44e) asking for the sanctioned green-run command.
  Typecheck green; test files committed (80fd8c0c7, fe996cfa2, 8c0afbb20).
