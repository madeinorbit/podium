/**
 * Turbo's run summary, read as numbers instead of grepped for the words "cache hit".
 *
 * A cache proof has to say how much was reused, not merely that the phrase appeared:
 * "cache miss" shows up in a run that then hits on 23 of 24 tasks, and a proof that a
 * single-package run needed no full suite is a claim about the task COUNT. Both lines
 * are stable Turbo output; a run that printed neither did not get as far as Turbo.
 */
export interface TurboSummary {
  successful: number
  total: number
  cached: number
  /** Task ids Turbo listed as failed, when `--continue` let it name them all. */
  failed: string[]
}

const TASKS = /^\s*Tasks:\s+(\d+) successful, (\d+) total\s*$/m
const CACHED = /^\s*Cached:\s+(\d+) cached, (\d+) total\s*$/m
const FAILED = /^\s*Failed:\s+(.+?)\s*$/m

export function parseTurboSummary(output: string): TurboSummary | null {
  const tasks = TASKS.exec(output)
  const cached = CACHED.exec(output)
  if (!tasks || !cached) return null
  const failed = FAILED.exec(output)
  return {
    successful: Number(tasks[1]),
    total: Number(tasks[2]),
    cached: Number(cached[1]),
    failed: failed
      ? (failed[1] as string)
          .split(',')
          .map((task) => task.trim())
          .filter(Boolean)
      : [],
  }
}

/** Two runs attempted the same failing tasks. Turbo names them in completion order, so
 *  the comparison has to be by set and not by the order they came back in. */
function sameTaskSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const seen = new Set(right)
  return left.every((task) => seen.has(task))
}

/**
 * Every task the producer was able to cache came back without being recomputed, and the
 * reader attempted the same work to prove it.
 *
 * This is the reuse question, and it is not the same as `isFullHit`. Turbo caches only
 * SUCCESSFUL tasks, so in a repository where some task is red — and under isolated
 * linking three still are, tracked separately — a full hit is unreachable no matter how
 * perfectly the cache works. Comparing against what the producer actually cached asks
 * whether anything reusable was recomputed, which is the property under test.
 *
 * `reader.cached === producer.successful` ALONE is not that property, because it says
 * nothing about the universe the reader ran over. A reader whose filter, workspace list
 * or task graph shrank to exactly the producer's cacheable tasks reports the same number
 * while never attempting the rest — the strongest-looking evidence in the report would
 * then be produced by running less. So the universe is pinned as well: the same total,
 * the same successful count, and the same set of failed tasks. Any of those three moving
 * means the two runs are not comparable, whatever the hit count says, and the caller is
 * told no rather than being handed a number it cannot interpret.
 */
export function reusedEverythingCacheable(
  producer: TurboSummary | null,
  reader: TurboSummary | null,
): boolean {
  if (!producer || !reader) return false
  if (producer.successful <= 0) return false
  return (
    reader.total === producer.total &&
    reader.successful === producer.successful &&
    sameTaskSet(reader.failed, producer.failed) &&
    reader.cached === producer.successful
  )
}

/** Every task replayed from the cache — Turbo's FULL TURBO. */
export function isFullHit(summary: TurboSummary | null): boolean {
  return summary !== null && summary.total > 0 && summary.cached === summary.total
}

/** Nothing replayed: the environment moved, so every task was recomputed. */
export function isFullMiss(summary: TurboSummary | null): boolean {
  return summary !== null && summary.total > 0 && summary.cached === 0
}
