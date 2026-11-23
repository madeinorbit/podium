import { execVersionProbe, type VersionProbeOutput } from '../apps/daemon/src/runtime/version-probe'
import { manifestFor } from '../packages/harness/src/registry'
import {
  gateHarnessVersion,
  HARNESS_VERSION_POLICIES,
  parseHarnessVersion,
} from '../packages/harness/src/version-policy'
import { AGENT_VERSION_PROBE_TIMEOUT_MS } from '../packages/harness/src/version-probe'

type Harness = keyof typeof HARNESS_VERSION_POLICIES

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

const fixtureDirectories: Partial<Record<Harness, string>> = {
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok-acp',
}

/** Machine-local advice, never an admission gate or a cached lint result. */
export async function lintHarnessVersions(
  probe: (
    command: string,
    timeoutMs: number,
  ) => VersionProbeOutput | Promise<VersionProbeOutput> = (command, timeoutMs) =>
    // Developer tooling: asks the developer's own shell environment.
    execVersionProbe(command, timeoutMs, definedEnv(process.env)),
  warn: (message: string) => void = console.warn,
): Promise<0> {
  await Promise.all(
    Object.entries(HARNESS_VERSION_POLICIES).map(async ([name, policy]) => {
      try {
        const executable = manifestFor(name)?.inventory.executable.names[0] ?? name
        const result = await probe(executable, AGENT_VERSION_PROBE_TIMEOUT_MS)
        if (!result.ok || gateHarnessVersion(policy, result.output) !== 'unverified') return
        const version = parseHarnessVersion(result.output)
        if (!version) return
        const directory = fixtureDirectories[name as Harness]
        const location = directory
          ? `packages/harness/src/driver/families/${directory}/__fixtures__`
          : `packages/harness/src/adapters/${name}`
        const command = name === 'codex' ? ' (codex app-server generate-ts --out DIR)' : ''
        warn(
          `WARNING: ${name} ${version.major}.${version.minor}.${version.patch} installed, verified through ${policy.verifiedThrough} - re-record fixtures in ${location} when convenient${command}`,
        )
      } catch {
        // Missing binaries, timed-out probes and other inconclusive results are silent.
      }
    }),
  )
  return 0
}

if (import.meta.main) process.exitCode = await lintHarnessVersions()
