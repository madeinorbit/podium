import { useEffect } from 'react'
import { updateStatus } from '@/lib/update-status'
import { useWorklistPool } from './store-worklist-pool'

/**
 * Hands the pool to the update-status reader (POD-6683), so an update or server
 * move started on another device shows within a second while sync works. The
 * reader never depends on it: the update panel mounts above the store and keeps
 * working when the replica is down. Renders nothing.
 */
export function UpdateEffectsObserver(): null {
  const pool = useWorklistPool()
  useEffect(() => (pool ? updateStatus().followEffects(pool) : undefined), [pool])
  return null
}
