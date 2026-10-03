
import { usePoolLifecycleSettings } from '@/app/header-data'
import type { PodiumSettings } from '@podium/runtime'

/** @deprecated Prefer {@link useHostLifecycleSettings}; kept for call sites that
 *  only need the hibernation half. */
export function useHibernationSetting(): PodiumSettings['hibernation'] | null {
  return useHostLifecycleSettings()?.hibernation ?? null
}

export function useHostLifecycleSettings(): ReturnType<typeof usePoolLifecycleSettings> {
  return usePoolLifecycleSettings()
}
