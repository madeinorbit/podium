/**
 * POD-4445 — the required per-row commit wrapper every round-two arm uses.
 *
 * Each arm's row component renders inside `<RowShell id={rowId}>`. Under the
 * count harness the shell is a `React.Profiler` reporting every non-mount
 * commit to the harness-provided log; outside the harness (production entries,
 * arm unit tests) the context is absent and the shell renders its children
 * untouched — zero behavior change, zero cost beyond one context read.
 *
 * Why a wrapper and not a hook: hooks cannot observe their own component's
 * commit. `Profiler.onRender` fires exactly when React commits the wrapped
 * subtree, which is the methodology's "rows committed" (§5.8) as the user sees
 * it — including the whole-array-props and fresh-closure commits the control
 * exists to exhibit. happy-dom has no paint, so this counter is commits, never
 * wall time; walls come from Chromium (G4 browser driver) only.
 */

import { createContext, Profiler, useContext, type ReactElement, type ReactNode } from 'react'

/** Harness-side sink. `record` fires once per committed (non-mount) render. */
export interface CommitSink {
  record(rowId: string): void
}

/** Counts per row id since construction or the last `reset()`. */
export interface CommitLog extends CommitSink {
  readonly counts: ReadonlyMap<string, number>
  /** Total committed renders across all rows. */
  total(): number
  reset(): void
}

export function createCommitLog(): CommitLog {
  const counts = new Map<string, number>()
  return {
    counts,
    record(rowId: string): void {
      counts.set(rowId, (counts.get(rowId) ?? 0) + 1)
    },
    total(): number {
      let sum = 0
      for (const n of counts.values()) sum += n
      return sum
    },
    reset(): void {
      counts.clear()
    },
  }
}

/**
 * The harness provides this; arms only consume it through `RowShell`.
 * `null` (the default) means "not measured" — arms render normally.
 */
export const CommitLogContext = createContext<CommitLog | null>(null)

/**
 * Ambient fallback for `mountWeb(el)` roots. An arm's `mountWeb` renders
 * through its own `createRoot`, which cannot inherit the harness provider's
 * context across the root boundary — so the harness sets the ambient log
 * around mount and around each counted scenario (`withCommitLog`), and
 * `RowShell` prefers context, then ambient. Single-threaded counting only
 * (CI happy-dom, one browser page): set and cleared symmetrically, never held
 * across scenarios, never read as timing.
 */
let ambientLog: CommitLog | null = null

export function withCommitLog<T>(log: CommitLog | null, fn: () => T): T {
  const previous = ambientLog
  ambientLog = log
  try {
    return fn()
  } finally {
    ambientLog = previous
  }
}

/**
 * REQUIRED wrapper around every arm row component (methodology §6.1 shape
 * review: "Row isolation — one subscription key per row"; this shell is how
 * the harness verifies it). `id` is the slice row id.
 */
export function RowShell({ id, children }: { id: string; children: ReactNode }): ReactElement {
  const log = useContext(CommitLogContext) ?? ambientLog
  if (log === null) return <>{children}</>
  return (
    <Profiler
      id={`worklist-row:${id}`}
      onRender={(_profilerId, phase) => {
        if (phase !== 'mount') log.record(id)
      }}
    >
      {children}
    </Profiler>
  )
}
