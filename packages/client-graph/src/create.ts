import type { LocalsSource, RowSource } from './shared/source'
import { worklistView } from './worklist/view-model'
import { MobxPool, type PoolLazyOptions } from './pool'

export interface WorklistPoolHandle {
  readonly pool: MobxPool
  dispose(): void
}

/** Follow the caller's row and local channels; the caller owns those channels. */
export function createWorklistPool(
  source: RowSource,
  locals: LocalsSource,
  loader: Omit<PoolLazyOptions, 'load' | 'issueIdByRef'> = {},
  selectionOwner: 'locals' | 'worklist' = 'locals',
): WorklistPoolHandle {
  const row = source.row?.bind(source)
  if (row === undefined) {
    throw new Error(
      '[pool] the feed has no per-row read (RowSource.row): a lazy pool cannot load a cold row',
    )
  }
  const pool = new MobxPool(locals.get(), undefined, {
    ...loader,
    diagnostics: source.diagnostics,
    issueSessionFact: source.issueSessionFact,
    load: row,
    exitKind: source.exitKind?.bind(source),
    issueIdByRef: source.issueIdByRef?.bind(source),
    cold: source.cold?.bind(source),
  })
  // POD-5407: a source with its own cold index hands over only the rows that
  // are never cold (lanes); the pool places the index's resident candidates
  // itself, each read once by id. No history row is visited.
  pool.apply({
    type: 'replace',
    rows:
      source.cold === undefined
        ? [
            ...source.snapshot('session'),
            ...source.snapshot('issue'),
            ...source.snapshot('worktree'),
            ...(source.companions?.() ?? []),
          ]
        : [...source.snapshot('worktree'), ...(source.companions?.() ?? [])],
  })
  const offRows = source.subscribe((event) => pool.apply(event))
  const offLocals = locals.subscribe((changed) => {
    if (selectionOwner === 'locals') worklistView(pool).applyLocals(locals.get(), changed)
    if (changed.has('coarseNow')) pool.applyLocals(locals.get(), new Set(['coarseNow']))
  })
  return {
    pool,
    dispose(): void {
      offRows()
      offLocals()
      pool.dispose()
    },
  }
}
