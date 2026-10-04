import type { MobxPool } from '@podium/client-graph/pool'
import { useCallback } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'

/** A row-local subscription to the pool's parked transaction index. */
export function NotSavedMark({ kind, id }: { kind: 'issue' | 'session'; id: string }) {
  const read = useCallback((pool: MobxPool) => pool.notSaved(kind, id), [kind, id])
  const notSaved = useWorklistPoolProjection(read, false)
  return notSaved ? (
    <span data-testid="not-saved" role="status" className="flex-none text-destructive">
      not saved
    </span>
  ) : null
}
