/**
 * POD-4445 — the per-row commit wrapper — and POD-4547 (L1b) — the row
 * capability rule.
 *
 * TWO WRAPPERS, ONE COUNTER.
 *
 * `RowShell({ row, component })` is the ONLY way a round-three arm renders a
 * row. It takes the row's `RowView` and a `RowComponent` — a component whose
 * props are exactly `{ row: RowView }` — and renders `<component row={row} />`
 * itself. A component that also takes a store handle, an entity array or a
 * wider row does not compile against it (`row-contract.types.test.tsx`), so the
 * round-two F foot-gun — an O(N) scan inside a row that held the store
 * (`docs/decisions/4441-k-hand-exercise.md` Table 2 F) — has no props channel.
 * Stable callbacks (spec §4: click selects) arrive through `RowActionsContext`,
 * typed to the `RowActions` interface, never through props.
 *
 * `CommitBoundary({ id, children })` is the raw counting wrapper this file
 * shipped as `RowShell` in round two. It stays for the legacy control and the
 * frozen round-two arms: the control exists to exhibit whole-array props and
 * store-reading rows, so it must NOT be able to use the enforcing shell. A
 * round-three arm that renders a row through `CommitBoundary` fails the shape
 * review.
 *
 * WHAT THE TYPES DO NOT CLOSE. Props are one channel. A row module can still
 * import a module-level store, call a store hook, or be a closure over one
 * (`component={(p) => <Row {...p} store={store} />}`). The inline-closure form
 * changes component identity every render, and `RowShell` throws on that (a
 * remount per render is a defect anyway). The import, hook and memoised
 * closure forms are lint-shaped and belong to the safety fences (L6), not to
 * the type system.
 *
 * COUNTING. Under the count harness both wrappers are a `React.Profiler`
 * reporting every non-mount commit to the harness-provided log; outside the
 * harness (production entries, arm unit tests) the context is absent and they
 * render their children untouched — zero behavior change, zero cost beyond one
 * context read.
 *
 * Why a wrapper and not a hook: hooks cannot observe their own component's
 * commit. `Profiler.onRender` fires exactly when React commits the wrapped
 * subtree, which is the methodology's "rows committed" (§5.8) as the user sees
 * it — including the whole-array-props and fresh-closure commits the control
 * exists to exhibit. happy-dom has no paint, so this counter is commits, never
 * wall time; walls come from Chromium (G4 browser driver) only.
 */

import {
  createContext,
  Profiler,
  useContext,
  useRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { RowView } from './row-view'

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
 * The harness provides this; arms only consume it through `RowShell`
 * (or, for the legacy control and round-two arms, `CommitBoundary`).
 * `null` (the default) means "not measured" — arms render normally.
 */
export const CommitLogContext = createContext<CommitLog | null>(null)

/**
 * Ambient fallback for `mountWeb(el)` roots. An arm's `mountWeb` renders
 * through its own `createRoot`, which cannot inherit the harness provider's
 * context across the root boundary — so the harness sets the ambient log
 * around mount and around each counted scenario (`withCommitLog`), and
 * the wrappers prefer context, then ambient. Single-threaded counting only
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
 * The log in scope at `mountWeb` time. An arm's `mountWeb` renders through
 * its own root, which cannot inherit the harness provider's context — so it
 * MUST capture this at mount and re-provide it explicitly:
 *
 *   mountWeb(el) {
 *     const log = currentCommitLog()
 *     root.render(
 *       <CommitLogContext.Provider value={log}>...</CommitLogContext.Provider>,
 *     )
 *   }
 *
 * (`value={null}` outside the harness is a pass-through.) Relying on the
 * ambient fallback at commit time instead is wrong: React may commit after
 * the counting scope has closed, and concurrent mounts would share one log.
 */
export function currentCommitLog(): CommitLog | null {
  return ambientLog
}

/**
 * Async variant: holds the ambient log until the returned promise settles,
 * so `mountWeb` captures made in effects flushed by an async `act` still see
 * it. The sync `withCommitLog` restores when its function returns — too early
 * when the function is async — so async harnesses must use this one.
 */
export async function withCommitLogAsync<T>(
  log: CommitLog | null,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = ambientLog
  ambientLog = log
  try {
    return await fn()
  } finally {
    ambientLog = previous
  }
}

/**
 * The raw per-row commit counter (round two's `RowShell`, renamed). `id` is
 * the slice row id. LEGACY CONTROL AND FROZEN ROUND-TWO ARMS ONLY: it accepts
 * any children, so it enforces nothing. Round-three arms use `RowShell`.
 */
export function CommitBoundary({ id, children }: { id: string; children: ReactNode }): ReactElement {
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

// -----------------------------------------------------------------------------
// The capability rule (L1b)
// -----------------------------------------------------------------------------

/** Everything a row component receives: its own view. Nothing else. */
export interface RowProps {
  readonly row: RowView
}

/**
 * A row component: accepts exactly `{ row: RowView }`. `memo(...)` and
 * MobX `observer(...)` wrappers of such a function qualify.
 */
export type RowComponent = ComponentType<RowProps>

/**
 * Compile-time guard for `RowShell`'s `component`. Resolves to `unknown` (no
 * constraint) when `P` is exactly a row component's props; otherwise to an
 * object with a `never`-typed property whose NAME is the error message, so the
 * compiler reports why:
 *   - any prop besides `row` (a store, an array, a callback — even optional);
 *     `key`/`ref` are React's and carry nothing;
 *   - a `row` wider than `RowView` (`RowView & { sessions }`): the component
 *     would read fields the view does not have.
 */
export type RowOnly<P> = [Exclude<keyof P, 'row' | 'key' | 'ref'>] extends [never]
  ? P extends { readonly row: infer R }
    ? [RowView] extends [R]
      ? unknown
      : { readonly 'row component expects more than RowView': never }
    : { readonly 'row component takes no row prop': never }
  : { readonly [K in Exclude<keyof P, 'row' | 'key' | 'ref'> as `row component takes a prop other than row: ${K & string}`]: never }

/**
 * Stable callbacks a row may invoke (spec §4 UI contract). Id-taking only:
 * the row names itself; the list's handler does the rest.
 */
export interface RowActions {
  /** Row click (spec R-SEL; the draft-vessel open is the handler's choice, §4). */
  select(id: string): void
}

/** Provided once by the list, with a stable value. */
export const RowActionsContext = createContext<RowActions | null>(null)

/** The row's actions; throws outside a list that provides them. */
export function useRowActions(): RowActions {
  const actions = useContext(RowActionsContext)
  if (actions === null) throw new Error('useRowActions: no RowActionsContext provider above this row')
  return actions
}

/**
 * REQUIRED wrapper around every round-three row (methodology §6.1 shape
 * review: "Row isolation — one subscription key per row"; this shell is how
 * the harness verifies it AND how the capability rule is enforced). Renders
 * `<component row={row} />` inside the commit counter for `row.id`.
 *
 * Throws if `component` changes identity between renders of one shell: an
 * inline component remounts its row on every render and is the natural way to
 * smuggle a store in by closure.
 */
export function RowShell<P extends RowProps>({
  row,
  component,
}: {
  row: RowView
  component: ComponentType<P> & RowOnly<P>
}): ReactElement {
  const first = useRef(component)
  if (first.current !== component) {
    throw new Error(
      `RowShell(${row.id}): component identity changed between renders; declare the row component once at module scope`,
    )
  }
  // `RowOnly<P>` proved P is exactly `RowProps` (plus React's key/ref).
  const Row = component as unknown as ComponentType<RowProps>
  return (
    <CommitBoundary id={row.id}>
      <Row row={row} />
    </CommitBoundary>
  )
}
