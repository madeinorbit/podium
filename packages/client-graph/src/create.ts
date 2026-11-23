import { MobxPool, type PoolLazyOptions } from './pool'
import type { LocalsSource, RowSource } from './shared/source'
import { worklistView } from './worklist/view-model'

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
      '[pool] the feed has no per-row read (RowSource.row): a lazy pool cannot answer an absent row',
    )
  }
  const pool = new MobxPool(locals.get(), undefined, {
    ...loader,
    diagnostics: source.diagnostics,
    issueSessionFact: source.issueSessionFact,
    load: row,
    exitKind: source.exitKind?.bind(source),
    issueIdByRef: source.issueIdByRef?.bind(source),
    ...(source.loader === undefined ? {} : { loader: source.loader.bind(source) }),
  })
  // POD-7094: every row the device holds is in the pool.
  pool.apply({
    type: 'replace',
    rows: [
      ...source.snapshot('session'),
      ...source.snapshot('issue'),
      ...source.snapshot('worktree'),
      ...(source.companions?.() ?? []),
    ],
  })
  const offRows = source.subscribe((event) => pool.apply(event))
  const offLocals = locals.subscribe((changed) => {
    if (selectionOwner === 'locals') worklistView(pool).applyLocals(locals.get(), changed)
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
