/** Store-owned, opt-in chip census. No row, token, label or title is retained. */
export interface ChipCounts {
  legacyScans: number
  legacyRows: number
  reads: number
  redraws: number
  resolveBatches: number
  resolveRefs: number
}
const empty = (): ChipCounts => ({ legacyScans: 0, legacyRows: 0, reads: 0, redraws: 0, resolveBatches: 0, resolveRefs: 0 })
export interface ChipCheckReport {
  state: 'off' | 'waiting' | 'match' | 'different' | 'error'
  checks: number
  chips: number
  pending: number
  differences: number
  first: { chipIndex: number; expectedId: string | null; actualId: string | null; field: string } | null
}
let enabled = false
let owners = new WeakMap<object, ChipCounts>()
const checks = new WeakMap<object, ChipCheckReport>()

export function reportChipCheck(owner: object, report: ChipCheckReport): void { checks.set(owner, report) }
export function chipCheckFor(owner: object): ChipCheckReport | null { return checks.get(owner) ?? null }

export function recordChipWork(owner: object, metric: keyof ChipCounts, amount = 1): void {
  if (!enabled) return
  let counts = owners.get(owner)
  if (!counts) { counts = empty(); owners.set(owner, counts) }
  counts[metric] += amount
}

export const chipPerf = {
  enable(value = true): void { enabled = value },
  reset(): void { owners = new WeakMap() },
  read(owner: object): ChipCounts & { enabled: boolean } {
    return { ...empty(), ...owners.get(owner), enabled }
  },
}
