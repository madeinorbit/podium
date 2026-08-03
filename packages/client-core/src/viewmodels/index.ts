// Entity-pure predicates live in @podium/model (#194). The slices import them
// directly; this barrel republishes the same BINDINGS (not new `export const`/
// `export function` declarations — see scripts/check-boundaries.ts rule 7,
// which flags exactly that shape) so existing
// `@podium/client-core/viewmodels` call sites keep working unchanged. This is
// the last residue of the deleted `derive.ts`: a re-export list on the barrel,
// not a module of its own — there is nothing here to own.
export {
  agentCapabilityRejection,
  DEFER_NEXT_MESSAGE,
  dedupeSessionsByResume,
  isHeadlessSession,
  isIssueDeferred,
  isSnoozed,
  issueReturnedFromDefer,
  lastUsedMachine,
  machinesForRepo,
  machinesForRepoOrClone,
  machinesWithRepo,
  normalizeOriginUrl,
  onlineMachinesForRepoOrClone,
  repoNameFromOrigin,
  resolveTargetMachine,
  resolveTargetMachineForAgent,
  returnedFromSnooze,
  snoozeUntil1h,
  snoozeUntilTomorrow5am,
  withoutHeadless,
  worktreeForCwd,
} from '@podium/model'
export * from './ask-question'
export * from './board-scope'
export * from './chat'
export * from './cursor-order'
export * from './dock-panel'
export * from './file-scope'
export * from './optimistic-spawn'
export * from './session-card'
export * from './session-ownership'
export * from './session-status'
export * from './session-urgency'
export * from './slices/chat'
export * from './slices/issues'
export * from './slices/machines/authority'
export * from './slices/machines/facts'
export * from './slices/machines/placement'
export * from './slices/publish'
export * from './slices/superagent'
export * from './slices/terminal'
export * from './slices/workflows'
export * from './slices/worklist/folds'
export * from './slices/worklist/machine-scope'
export * from './slices/worklist/nav'
export * from './slices/worklist/published'
export * from './slices/worklist/row-attention'
export * from './slices/worklist/row-order'
export * from './slices/worklist/row-types'
export * from './slices/worklist/rows'
export * from './slices/worklist/session-groups'
export * from './slices/worklist/visibility'
export * from './transcript'
export * from './tray'
export * from './types'
