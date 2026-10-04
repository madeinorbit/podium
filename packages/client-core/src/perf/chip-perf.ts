/** Store-owned, opt-in chip census. No row, token, label or title is retained. */
export interface ChipCounts {
  reads: number
  redraws: number
  resolveBatches: number
  resolveRefs: number
}
const empty = (): ChipCounts => ({
  reads: 0,
  redraws: 0,
  resolveBatches: 0,
  resolveRefs: 0,
})
let enabled = false
let owners = new WeakMap<object, ChipCounts>()
export function recordChipWork(owner: object, metric: keyof ChipCounts, amount = 1): void {
  if (!enabled) return
  let counts = owners.get(owner)
  if (!counts) {
    counts = empty()
    owners.set(owner, counts)
  }
  counts[metric] += amount
}

export const chipPerf = {
  enable(value = true): void {
    enabled = value
  },
  reset(): void {
    owners = new WeakMap()
  },
  read(owner: object): ChipCounts & { enabled: boolean } {
    return { ...empty(), ...owners.get(owner), enabled }
  },
}
