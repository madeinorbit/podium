import type { LocalsSource, RowSource } from './shared/source'
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
    load: row,
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
            ...source.snapshot('repo'),
            ...source.snapshot('machine'),
          ]
        : [...source.snapshot('worktree'), ...source.snapshot('repo'), ...source.snapshot('machine')],
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
