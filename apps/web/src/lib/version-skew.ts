import type { MachineWire } from '@podium/model'
import { useEffect, useState } from 'react'
import type { Store } from '@/app/store'

/**
 * POD-838: the server's own build version, fetched once from setup.info.
 * null while unknown (loading, older server, or a failed probe) — callers must
 * treat that as "no skew signal", never as "up to date".
 */
export function useServerAppVersion(trpc: Store['trpc']): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const info = await trpc.setup.info.query()
        if (!cancelled && typeof info.appVersion === 'string') setVersion(info.appVersion)
      } catch {
        // Version is decorative — a failed probe just means no badge.
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [trpc])
  return version
}

/**
 * Prefer the server's per-machine update verdict: it is derived from the target of
 * the channel selected for this machine. Falling back to the server build is only
 * for compatibility with older servers that did not project channel targets.
 */
export function machineNeedsUpdate(
  machine: Pick<MachineWire, 'inventory' | 'targetVersion' | 'versionState'>,
  serverAppVersion: string | null,
): boolean {
  const daemonVersion = machine.inventory?.podiumVersion

  if (machine.versionState !== undefined) return machine.versionState === 'behind'

  if (machine.targetVersion !== undefined) {
    return (
      daemonVersion != null &&
      machine.targetVersion != null &&
      daemonVersion !== machine.targetVersion
    )
  }

  // Legacy projection: 'dev' carries no comparable release identity.
  return (
    daemonVersion != null &&
    serverAppVersion != null &&
    daemonVersion !== 'dev' &&
    serverAppVersion !== 'dev' &&
    daemonVersion !== serverAppVersion
  )
}
