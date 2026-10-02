import type { LocalsSource, RowSource } from './shared/source'
import { MobxPool, type PoolLazyOptions, type WriteSeam } from './pool'

export interface WorklistPoolHandle {
  readonly pool: MobxPool
  dispose(): void
}

/** Follow the caller's row and local channels; the caller owns those channels. */
export function createWorklistPool(
  source: RowSource,
  locals: LocalsSource,
  loader: Omit<PoolLazyOptions, 'load' | 'issueIdByRef'> = {},
  writes?: WriteSeam,
): WorklistPoolHandle {
  const row = source.row?.bind(source)
  if (row === undefined) {
    throw new Error(
      '[pool] the feed has no per-row read (RowSource.row): a lazy pool cannot load a cold row',
    )
  }
  const pool = new MobxPool(locals.get(), undefined, {
    ...loader, load: row, issueIdByRef: source.issueIdByRef?.bind(source),
  }, writes)
  pool.apply({
    type: 'replace',
    rows: [
      ...source.snapshot('session'),
      ...source.snapshot('issue'),
      ...source.snapshot('worktree'),
    ],
  })
  const offRows = source.subscribe((event) => pool.apply(event))
  const offLocals = locals.subscribe((changed) => pool.applyLocals(locals.get(), changed))
  return {
    pool,
    dispose(): void {
      offRows()
      offLocals()
      pool.dispose()
    },
  }
}
