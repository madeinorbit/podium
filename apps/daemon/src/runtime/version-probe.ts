import { execFile } from 'node:child_process'

export interface VersionProbeOutput {
  output: string
  ok: boolean
}

export type VersionProbe = () => VersionProbeOutput | Promise<VersionProbeOutput>

/** An inconclusive answer suppresses bursts but expires so the host can recover. */
export const UNPROBEABLE_VERSION_CACHE_MS = 60_000

export interface ProbeVerdictShape {
  drivable: boolean
  reason?: 'unsupported' | 'unprobeable'
}

/**
 * Cache a three-valued version gate and coalesce callers behind one asynchronous
 * child. Definitive answers live for the daemon lifetime; inconclusive answers
 * live only long enough to keep a spawn burst from forking the same CLI again.
 */
export function createVersionProbeCache<Verdict extends ProbeVerdictShape>(input: {
  evaluate(result: VersionProbeOutput): Verdict
  now?: () => number
  unprobeableTtlMs?: number
}) {
  const now = input.now ?? Date.now
  const unprobeableTtlMs = input.unprobeableTtlMs ?? UNPROBEABLE_VERSION_CACHE_MS
  let definitive: Verdict | undefined
  let inconclusive: { verdict: Verdict; expiresAt: number } | undefined
  let inFlight: Promise<Verdict> | undefined

  return {
    probe(run: VersionProbe): Promise<Verdict> {
      if (definitive) return Promise.resolve(definitive)
      if (inconclusive && now() < inconclusive.expiresAt) {
        return Promise.resolve(inconclusive.verdict)
      }
      inconclusive = undefined
      if (inFlight) return inFlight

      let pending!: Promise<Verdict>
      pending = Promise.resolve()
        .then(run)
        .then(input.evaluate)
        .then((verdict) => {
          if (!verdict.drivable && verdict.reason === 'unprobeable') {
            inconclusive = { verdict, expiresAt: now() + unprobeableTtlMs }
          } else {
            definitive = verdict
          }
          return verdict
        })
        .finally(() => {
          if (inFlight === pending) inFlight = undefined
        })
      inFlight = pending
      return pending
    },

    reset(): void {
      definitive = undefined
      inconclusive = undefined
      inFlight = undefined
    },
  }
}

/** Run a bounded version command without blocking the daemon event loop. */
export function execVersionProbe(command: string, timeoutMs: number): Promise<VersionProbeOutput> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['--version'],
      { encoding: 'utf8', timeout: timeoutMs },
      (error, stdout, stderr) => {
        resolve({
          output: `${stdout ?? ''}${stderr ?? ''}`.trim(),
          ok: error === null,
        })
      },
    )
  })
}
