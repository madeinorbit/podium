import type { MachineWire } from '@podium/protocol'
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
 * An older daemon silently loses additive protocol features (frames it doesn't know
 * are dropped), so any release mismatch counts as "needs update". 'dev' builds carry
 * no comparable release number — never badge against or for one.
 */
export function machineNeedsUpdate(
  machine: Pick<MachineWire, 'inventory'>,
  serverAppVersion: string | null,
): boolean {
  const daemonVersion = machine.inventory?.podiumVersion
  return (
    daemonVersion != null &&
    serverAppVersion != null &&
    daemonVersion !== 'dev' &&
    serverAppVersion !== 'dev' &&
    daemonVersion !== serverAppVersion
  )
}
