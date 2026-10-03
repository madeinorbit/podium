import { recordSliceDerivation } from './store-stats'

/** Opt-in, bounded counters contain work counts only, never issue content. */
let enabled = false
let counts: Record<string, number> = {}
export const issueBoardStats = {
  enable() { enabled = true },
  disable() { enabled = false; counts = {} },
  reset() { counts = {} },
  read() { return { ...counts } },
}
export function countIssueBoard(name: string, count = 1): void {
  if (enabled && (Object.hasOwn(counts, name) || Object.keys(counts).length < 32)) counts[name] = (counts[name] ?? 0) + count
}
export function legacyIssueBoard<T>(owner: object, name: 'board' | 'explorer', read: () => T): T {
  recordSliceDerivation(owner, `issueBoard.${name}`)
  countIssueBoard(`legacy.${name}`)
  return read()
}
