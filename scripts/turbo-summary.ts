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
}

const TASKS = /^\s*Tasks:\s+(\d+) successful, (\d+) total\s*$/m
const CACHED = /^\s*Cached:\s+(\d+) cached, (\d+) total\s*$/m

export function parseTurboSummary(output: string): TurboSummary | null {
  const tasks = TASKS.exec(output)
  const cached = CACHED.exec(output)
  if (!tasks || !cached) return null
  return {
    successful: Number(tasks[1]),
    total: Number(tasks[2]),
    cached: Number(cached[1]),
  }
}

/** Every task replayed from the cache — Turbo's FULL TURBO. */
export function isFullHit(summary: TurboSummary | null): boolean {
  return summary !== null && summary.total > 0 && summary.cached === summary.total
}

/** Nothing replayed: the environment moved, so every task was recomputed. */
export function isFullMiss(summary: TurboSummary | null): boolean {
  return summary !== null && summary.total > 0 && summary.cached === 0
}
