import { execFile } from 'node:child_process'
import type { AgentKind } from '@podium/model'
import { type AgentManifest, manifestFor } from '@podium/harness'
import {
  type CodexProbeVerdict,
  codexEngineFacts,
  codexHarnessKind,
  evaluateCodexVersionProbe,
  evaluateGrokAcpVersionProbe,
  type GrokAcpProbeVerdict,
  grokEngineFacts,
  grokHarnessKind,
  evaluateOpencode2VersionProbe,
  evaluateOpencodeVersionProbe,
  type OpencodeProbeVerdict,
  type OpencodeVersionDiagnostic,
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
  opencode2Flavor,
  opencodeFlavor,
  opencodeHarnessKind,
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

/** Run a bounded version command without blocking the daemon event loop. */
export function execVersionProbe(command: string, timeoutMs: number): Promise<VersionProbeOutput> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['--version'],
      { encoding: 'utf8', timeout: timeoutMs },
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
// The default probes ask "what can this MACHINE run" in the daemon's own env,
// reading no per-user state.
// ---------------------------------------------------------------------------

/** The shared probe budget — one constant for all three probe sites, because
 *  POD-2056 established what two numbers for one concept cost. */
const VERSION_PROBE_TIMEOUT_MS = OPENCODE_VERSION_PROBE_TIMEOUT_MS

/**
 * The composition root's side of the POD-4494 handover: the families take
 * handed sections, so each default probe reads its adapter here — the one
 * place on this path allowed to name a harness — and hands the sections in.
 * Kinds arrive as the families' own values, never literals (vendor lint).
 */
function engineSections(
  kind: AgentKind,
): Pick<AgentManifest, 'kind' | 'runtime' | 'inventory'> {
  const manifest = manifestFor(kind)
  if (!manifest) throw new Error(`no harness adapter for '${kind}'`)
  return { kind: manifest.kind, runtime: manifest.runtime, inventory: manifest.inventory }
}

const codexProbeCache = createVersionProbeCache<CodexProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateCodexVersionProbe(output, ok),
})

export function codexAppServerVersionProbe(
  probe: VersionProbe = () =>
    execVersionProbe(
      codexEngineFacts(engineSections(codexHarnessKind)).executableName,
      VERSION_PROBE_TIMEOUT_MS,
    ),
  policy?: VersionProbePolicy,
): Promise<CodexProbeVerdict> {
  return codexProbeCache.probe(probe, policy)
}

/** Reset the memo. Tests only — a daemon never needs it. */
export function resetCodexAppServerVersionProbe(): void {
  codexProbeCache.reset()
}

const grokProbeCache = createVersionProbeCache<GrokAcpProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateGrokAcpVersionProbe(output, ok),
})

export function grokAcpVersionProbe(
  probe: VersionProbe = () =>
    execVersionProbe(
      grokEngineFacts(engineSections(grokHarnessKind)).executableName,
      VERSION_PROBE_TIMEOUT_MS,
    ),
  policy?: VersionProbePolicy,
): Promise<GrokAcpProbeVerdict> {
  return grokProbeCache.probe(probe, policy)
}

export function resetGrokAcpVersionProbe(): void {
  grokProbeCache.reset()
}

const opencodeProbeCache = createVersionProbeCache<OpencodeProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateOpencodeVersionProbe(output, ok),
})

export function opencodeVersionProbe(
  probe: VersionProbe = () =>
    execVersionProbe(
      opencodeFlavor(engineSections(opencodeHarnessKind)).executableName,
      VERSION_PROBE_TIMEOUT_MS,
    ),
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return opencodeProbeCache.probe(probe, policy)
}

export function opencodeVersionProbeForExecutable(
  executablePath: string,
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return opencodeVersionProbe(
    () => execVersionProbe(executablePath, VERSION_PROBE_TIMEOUT_MS),
    policy,
  )
}

const opencode2ProbeCache = createVersionProbeCache<OpencodeProbeVerdict>({
  evaluate: ({ output, ok }) => evaluateOpencode2VersionProbe(output, ok),
})

export function opencode2VersionProbe(
  probe: VersionProbe = () =>
    execVersionProbe(
      opencode2Flavor(engineSections(opencodeHarnessKind)).executableName,
      VERSION_PROBE_TIMEOUT_MS,
    ),
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return opencode2ProbeCache.probe(probe, policy)
}

export function opencode2VersionProbeForExecutable(
  executablePath: string,
  policy?: VersionProbePolicy,
): Promise<OpencodeProbeVerdict> {
  return opencode2VersionProbe(
    () => execVersionProbe(executablePath, VERSION_PROBE_TIMEOUT_MS),
    policy,
  )
}

export function opencode2VersionDiagnostic(
  probe?: VersionProbe,
): Promise<OpencodeVersionDiagnostic | null> {
  return opencode2VersionProbe(probe).then((verdict) =>
    verdict.drivable ? null : verdict.diagnostic,
  )
}

export function opencodeVersionDiagnostic(
  probe?: VersionProbe,
): Promise<OpencodeVersionDiagnostic | null> {
  return (probe ? opencodeVersionProbe(probe) : opencodeVersionProbe()).then((verdict) =>
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
