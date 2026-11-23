import { execFile } from 'node:child_process'
import type { HarnessInstallation } from '@podium/harness'
import {
  type CodexProbeVerdict,
  evaluateCodexVersionProbe,
  evaluateGrokAcpVersionProbe,
  type GrokAcpProbeVerdict,
  evaluateOpencode2VersionProbe,
  evaluateOpencodeVersionProbe,
  type OpencodeProbeVerdict,
  type OpencodeVersionDiagnostic,
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
} from '@podium/harness/driver/host'
import { reportHarnessProbe } from '../harness-version-reporting'

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

export interface VersionProbePolicy {
  /** A deliberate retry may bypass a completed transient miss, but still joins
   *  a probe another caller already has in flight. */
  retryInconclusive?: boolean
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
    probe(run: VersionProbe, policy: VersionProbePolicy = {}): Promise<Verdict> {
      if (definitive) return Promise.resolve(definitive)
      // In-flight before completed-inconclusive is load-bearing: concurrent
      // deliberate retries coalesce behind the same child instead of each
      // bypassing the stale verdict and forking its own.
      if (inFlight) return inFlight
      if (!policy.retryInconclusive && inconclusive && now() < inconclusive.expiresAt) {
        return Promise.resolve(inconclusive.verdict)
      }
      inconclusive = undefined

      let pending!: Promise<Verdict>
      pending = Promise.resolve()
        .then(run)
        .then(input.evaluate)
        .then((verdict) => {
          if (verdict.reason === 'unprobeable') {
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

/** Run a bounded version command without blocking the daemon event loop.
 *  `env` is the MACHINE command environment (design §3.3 "machine scope"):
 *  never the daemon's own `process.env`, never an account env. */
export function execVersionProbe(
  command: string,
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
): Promise<VersionProbeOutput> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['--version'],
      { encoding: 'utf8', timeout: timeoutMs, env: { ...env } },
      (error, stdout, stderr) => {
        if (!error) reportHarnessProbe(command, `${stdout ?? ''}${stderr ?? ''}`)
        resolve({
          output: `${stdout ?? ''}${stderr ?? ''}`.trim(),
          ok: error === null,
        })
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Per-harness admission gates (moved from the engine hosts in 1.5).
//
// The supervisor owns the probe budget, the memo and the fork (above); each
// driver family owns what the output MEANS (the `evaluate*` functions, beside
// the version policy they read). These compositions keep the names the spawn
// path and the tests already call, so the move changes addresses, not calls.
//
// EVERY GATE IS ABOUT ONE INSTALLATION (POD-6546). It asks "what does THIS
// executable report", for the installation the session pinned: the version
// the inventory already verified when it has one, otherwise the executable
// itself under the machine command environment. Never a bare name on the
// daemon's PATH — on a GUI-launched daemon that finds nothing, or a different
// install. And each verdict is cached under its executable and generation, so
// a verdict for one installation never vouches for another.
// ---------------------------------------------------------------------------

/** The shared probe budget — one constant for all three probe sites, because
 *  POD-2056 established what two numbers for one concept cost. */
const VERSION_PROBE_TIMEOUT_MS = OPENCODE_VERSION_PROBE_TIMEOUT_MS

/** What a version verdict is about: one installation in one generation. */
export type VersionProbeTarget = Pick<HarnessInstallation, 'executable' | 'version' | 'generation'>

export interface VersionProbeOptions {
  /** The machine command environment a live probe runs under. */
  env: Readonly<Record<string, string>>
  policy?: VersionProbePolicy
  /** Test seam: answers in place of the child process. */
  probe?: VersionProbe
}

/**
 * One {@link createVersionProbeCache} per installation. The key is the
 * executable path AND the command-environment generation: a refresh that
 * re-resolves the same path starts a fresh verdict, because the file behind it
 * may have been upgraded in place.
 */
export function createInstallationProbeCache<Verdict extends ProbeVerdictShape>(input: {
  evaluate(result: VersionProbeOutput): Verdict
  now?: () => number
  unprobeableTtlMs?: number
}) {
  const caches = new Map<string, ReturnType<typeof createVersionProbeCache<Verdict>>>()
  return {
    /**
     * The verdict for `target`. No installation (`undefined`) is answered as a
     * probe that could not run — exactly what the bare-name ENOENT used to
     * produce — and is never cached, because there is nothing to key it on.
     */
    probe(target: VersionProbeTarget | undefined, options: VersionProbeOptions): Promise<Verdict> {
      if (!target) return Promise.resolve(input.evaluate({ output: '', ok: false }))
      const key = `${target.generation}\u0000${target.executable}`
      let cache = caches.get(key)
      if (!cache) {
        cache = createVersionProbeCache<Verdict>(input)
        caches.set(key, cache)
      }
      const run: VersionProbe =
        options.probe ??
        (target.version
          ? // Verified by the inventory when it resolved this executable.
            () => ({ output: target.version, ok: true })
          : () => execVersionProbe(target.executable, VERSION_PROBE_TIMEOUT_MS, options.env))
      return cache.probe(run, options.policy)
    },
    reset(): void {
      caches.clear()
    },
  }
}

const codexProbeCache = createInstallationProbeCache<CodexProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateCodexVersionProbe(output, ok),
})

export function codexAppServerVersionProbe(
  target: VersionProbeTarget | undefined,
  options: VersionProbeOptions,
): Promise<CodexProbeVerdict> {
  return codexProbeCache.probe(target, options)
}

/** Reset the memo. Tests only — a daemon never needs it. */
export function resetCodexAppServerVersionProbe(): void {
  codexProbeCache.reset()
}

const grokProbeCache = createInstallationProbeCache<GrokAcpProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateGrokAcpVersionProbe(output, ok),
})

export function grokAcpVersionProbe(
  target: VersionProbeTarget | undefined,
  options: VersionProbeOptions,
): Promise<GrokAcpProbeVerdict> {
  return grokProbeCache.probe(target, options)
}

export function resetGrokAcpVersionProbe(): void {
  grokProbeCache.reset()
}

const opencodeProbeCache = createInstallationProbeCache<OpencodeProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateOpencodeVersionProbe(output, ok),
})

export function opencodeVersionProbe(
  target: VersionProbeTarget | undefined,
  options: VersionProbeOptions,
): Promise<OpencodeProbeVerdict> {
  return opencodeProbeCache.probe(target, options)
}

const opencode2ProbeCache = createInstallationProbeCache<OpencodeProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateOpencode2VersionProbe(output, ok),
})

export function opencode2VersionProbe(
  target: VersionProbeTarget | undefined,
  options: VersionProbeOptions,
): Promise<OpencodeProbeVerdict> {
  return opencode2ProbeCache.probe(target, options)
}

export function opencodeVersionDiagnostic(
  target: VersionProbeTarget | undefined,
  options: VersionProbeOptions,
): Promise<OpencodeVersionDiagnostic | null> {
  return opencodeVersionProbe(target, options).then((verdict) =>
    verdict.drivable ? null : verdict.diagnostic,
  )
}

export function resetOpencode2VersionProbe(): void {
  opencode2ProbeCache.reset()
}

/** Reset the memo. Tests only — a daemon never needs it. */
export function resetOpencodeVersionProbe(): void {
  opencodeProbeCache.reset()
}
