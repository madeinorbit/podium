/**
 * POD-4555 (L4a) — shrink a failing change sequence to a minimal one.
 *
 * Three passes, each keeping only candidates the predicate still calls
 * failing:
 *
 * 1. PREFIX. Binary search for the shortest failing prefix. A correctness
 *    failure usually shows at the step that caused it, so this cuts a
 *    1,000-step run to the failing step in ~10 runs. The search assumes the
 *    failure persists once it appears; when it does not, the pass keeps the
 *    whole input (the result is always a failing sequence).
 * 2. DELTA DEBUGGING (Zeller's ddmin) over that prefix: try each of n chunks
 *    alone, then each complement, doubling n when neither fails. It ends
 *    1-minimal: removing any single change makes the sequence pass.
 * 3. BATCHES. A surviving `batch` change is shrunk the same way over its own
 *    members, the rest of the sequence fixed.
 *
 * Changes that lose their prerequisite (an `accept` whose `edit` was cut, a
 * `reAdd` with no `evict`) are skipped by the runner, never an error, so every
 * subsequence is a runnable sequence.
 *
 * The predicate is memoised on the exact candidate (by index set), so no
 * candidate runs twice.
 */

import type { Change, RowChange } from './changes'

export type FailPredicate<T> = (candidate: readonly T[]) => boolean | Promise<boolean>

export interface ShrinkResult<T> {
  /** A failing subsequence of the input, 1-minimal. */
  result: T[]
  /** Length of the shortest failing prefix found by pass 1. */
  prefixLength: number
  /** Predicate runs (memo hits excluded). */
  runs: number
}

export interface ShrinkOptions {
  /** Stop after this many predicate runs and return the best so far. */
  maxRuns?: number
}

/** Shrink any sequence. Throws when `input` itself does not fail. */
export async function shrinkSequence<T>(
  input: readonly T[],
  fails: FailPredicate<T>,
  opts: ShrinkOptions = {},
): Promise<ShrinkResult<T>> {
  const maxRuns = opts.maxRuns ?? 2_000
  const memo = new Map<string, boolean>()
  let runs = 0
  const test = async (indices: readonly number[]): Promise<boolean> => {
    const key = indices.join(',')
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    if (runs >= maxRuns) return false
    runs += 1
    const verdict = await fails(indices.map((i) => input[i] as T))
    memo.set(key, verdict)
    return verdict
  }
  const all = input.map((_, i) => i)
  if (!(await test(all))) throw new Error('[shrink] the input sequence does not fail')

  // 1. Shortest failing prefix.
  let lo = 1
  let hi = all.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (await test(all.slice(0, mid))) hi = mid
    else lo = mid + 1
  }
  const prefixLength = hi
  let current = all.slice(0, prefixLength)

  // 2. ddmin: each chunk alone, then (n > 2) each complement.
  let n = 2
  while (current.length >= 2) {
    const chunks = split(current, n)
    const complements = n > 2 ? chunks.map((_, k) => chunks.filter((__, j) => j !== k).flat()) : []
    let next: number[] | null = null
    let nextN = n
    for (const [k, candidate] of [...chunks, ...complements].entries()) {
      if (await test(candidate)) {
        next = candidate
        nextN = k < chunks.length ? 2 : Math.max(n - 1, 2)
        break
      }
    }
    if (next) {
      current = next
      n = nextN
      continue
    }
    if (n >= current.length) break
    n = Math.min(n * 2, current.length)
  }
  return { result: current.map((i) => input[i] as T), prefixLength, runs }
}

function split(items: readonly number[], n: number): number[][] {
  const out: number[][] = []
  const size = items.length / n
  for (let k = 0; k < n; k += 1) {
    const chunk = items.slice(Math.round(k * size), Math.round((k + 1) * size))
    if (chunk.length > 0) out.push(chunk)
  }
  return out
}

/**
 * Shrink a failing change sequence: {@link shrinkSequence}, then each
 * surviving `batch` over its own members.
 */
export async function shrink(
  changes: readonly Change[],
  fails: FailPredicate<Change>,
  opts: ShrinkOptions = {},
): Promise<ShrinkResult<Change>> {
  const base = await shrinkSequence(changes, fails, opts)
  let result = base.result
  let runs = base.runs
  for (let at = 0; at < result.length; at += 1) {
    const c = result[at] as Change
    if (c.kind !== 'batch' || c.changes.length < 2) continue
    const withMembers = (members: readonly RowChange[]): Change[] => {
      const next = [...result]
      next[at] = { ...c, changes: [...members] }
      return next
    }
    const budget = (opts.maxRuns ?? 2_000) - runs
    if (budget <= 1) break
    const inner = await shrinkSequence(c.changes, (members) => fails(withMembers(members)), { maxRuns: budget })
    runs += inner.runs
    result = withMembers(inner.result)
  }
  return { result, prefixLength: base.prefixLength, runs }
}
