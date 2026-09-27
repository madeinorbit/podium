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
- Plan: new `harness/native/mobx-pool-fence.native.test.tsx` (#1-#3 via runFenceStep:
  parity + reads + no-copies + window-aware commits; planted whole-list plant failing
  the count; bootstrap observables cell) + `harness/native/entries.test.ts` (pin native
  entry to pool arm, no renderer) + README section.
