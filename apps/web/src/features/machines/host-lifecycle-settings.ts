import type { PodiumSettings } from '@podium/runtime'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'

/**
 * These hooks live apart from HostMemoryView on purpose: the always-mounted
 * header chips need them, but the info modal and load panel they used to share
 * a file with are click-to-open surfaces that load lazily (POD budget — the
 * eager bundle must not carry panel UI that only renders on demand).
 */

/** Lifecycle knobs the host-pressure surfaces need (hibernation + worktree GC).
 *  Lazily fetched so chips/panels reflect live settings without a settings store.
 *  Returns null until the first fetch resolves. */
export function useHostLifecycleSettings(): {
  hibernation: PodiumSettings['hibernation']
  worktreeGc: PodiumSettings['worktreeGc']
} | null {
  const trpc = useStoreSelector((s) => s.trpc)
  const [settings, setSettings] = useState<{
    hibernation: PodiumSettings['hibernation']
    worktreeGc: PodiumSettings['worktreeGc']
  } | null>(null)
  useEffect(() => {
    let alive = true
    trpc.settings.get
      .query()
      .then((s) => {
        if (alive) setSettings({ hibernation: s.hibernation, worktreeGc: s.worktreeGc })
      })
      .catch(() => {
        // Best-effort: a failed settings fetch just omits the lifecycle notes.
      })
    return () => {
      alive = false
    }
  }, [trpc])
  return settings
}

/** @deprecated Prefer {@link useHostLifecycleSettings}; kept for call sites that
 *  only need the hibernation half. */
export function useHibernationSetting(): PodiumSettings['hibernation'] | null {
  return useHostLifecycleSettings()?.hibernation ?? null
}
