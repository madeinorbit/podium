import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DriverCapabilities, SessionSpec } from '@podium/agent-runtime'
import { agentStateProviderFor, harnessInstanceHomeEnv, manifestFor } from '@podium/harness'
import type { AgentKind, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { ensurePodiumCodexHooks } from '../codex-hooks'
import { ensurePodiumGrokHooks } from '../grok-hooks'

type InstrumentationFailure =
  | 'no-home'
  | 'unreadable-hooks-json'
  | 'not-an-object'
  | 'unsupported-version'
  | 'untrusted'
  | 'error'

// Classify installer refusals only. Exceptions always use error, regardless of text.
function installerFailure(reason: string | undefined): InstrumentationFailure {
  if (
    reason === 'untrusted' ||
    reason?.startsWith('untrusted codex hooks') ||
    reason?.includes('hook trust')
  )
    return 'untrusted'
  switch (reason) {
    case 'no ~/.codex':
    case 'no GROK_HOME':
      return 'no-home'
    case 'unreadable hooks.json':
    case 'unreadable podium hook file':
      return 'unreadable-hooks-json'
    case 'hooks.json not an object':
    case 'podium hook file is not an object':
      return 'not-an-object'
    default:
      return reason === 'unsupported codex version' ||
        reason?.startsWith('unsupported codex version:')
        ? 'unsupported-version'
        : 'error'
  }
}

/** Launch wiring remains usable when global hook installation degrades. */
export interface InstalledTerminalInstrumentation {
  args: string[]
  degradedReason?: string
  degradedKind?: InstrumentationFailure
  env?: Record<string, string>
}

/** Both driver create/resume and wire-originated terminal creation use this gate. */
export async function prepareTerminalInstrumentation(
  capabilities: Pick<DriverCapabilities, 'instrumentation'>,
  spec: Pick<SessionSpec, 'instrumentation'>,
  install: () => Promise<InstalledTerminalInstrumentation>,
): Promise<InstalledTerminalInstrumentation> {
  if (capabilities.instrumentation === 'none') return { args: [] }
  if (!spec.instrumentation?.endpointUrl.trim()) {
    throw new Error('driver requires a per-session instrumentation endpoint')
  }
  return install()
}

// The global installers use atomic replacement with a fixed temporary path.
// Serialize sessions sharing a home; a failed install must not poison retries.
const installations = new Map<string, Promise<unknown>>()
async function serialized<T>(key: string, install: () => Promise<T>): Promise<T> {
  const previous = installations.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(install)
  installations.set(key, next)
  try {
    return await next
  } finally {
    if (installations.get(key) === next) installations.delete(key)
  }
}

/** The terminal driver's host-side installer. No daemon-boot prerequisite. */
export async function installTerminalInstrumentation(input: {
  sessionId: SessionId
  spec: SessionSpec
  settingsDir: string
  homeDir?: string
}): Promise<InstalledTerminalInstrumentation> {
  const { spec } = input
  const channel = spec.instrumentation
  if (!channel) throw new Error('missing terminal instrumentation channel')
  const manifest = manifestFor(spec.harness as AgentKind)
  const provider = agentStateProviderFor(spec.harness as AgentKind)
  if (!manifest || !provider || manifest.capabilities.hookInstall === 'none') {
    throw new Error(`no instrumentation installer for ${spec.harness}`)
  }
  let degradedReason: string | undefined
  let degradedKind: InstrumentationFailure = 'error'
  if (manifest.capabilities.hookInstall === 'global-env') {
    if (spec.harness !== 'codex' && spec.harness !== 'grok') {
      throw new Error(`no global instrumentation installer for ${spec.harness}`)
    }
    // Match the child environment: instance-owned homes override session values.
    const env = {
      ...process.env,
      ...spec.env,
      ...harnessInstanceHomeEnv(spec.harness, input.homeDir),
    }
    const homeDir = input.homeDir ?? env.HOME ?? homedir()
    const harnessHome =
      spec.harness === 'codex'
        ? env.CODEX_HOME?.trim() || join(homeDir, '.codex')
        : env.GROK_HOME?.trim() || join(homeDir, '.grok')
    try {
      const result = await serialized(`${spec.harness}:${harnessHome}`, () =>
        spec.harness === 'codex'
          ? ensurePodiumCodexHooks({ codexHome: harnessHome })
          : ensurePodiumGrokHooks({ grokHome: harnessHome }),
      )
      // POD-4076: an installed-but-untrusted Codex hook file reads as success
      // to the installer but runs nothing in Codex. Degrade loudly so the
      // session falls back to poll-only state with the operator told why.
      // Grok results carry no `trusted` field and never take this arm.
      if (!result.installed) {
        degradedReason = result.reason ?? 'hook installation failed'
        degradedKind = installerFailure(result.reason)
      } else if ('trusted' in result && result.trusted === false) {
        degradedReason = result.reason ?? 'untrusted codex hooks'
        degradedKind = 'untrusted'
      }
    } catch (error) {
      degradedReason = error instanceof Error ? error.message : String(error)
    }
  }
  const wiring = provider.instrumentation({
    ...channel,
    seedTheme: channel.seedTheme ?? true,
    settingsPath: join(input.settingsDir, `${input.sessionId}.json`),
  })
  if (wiring.file) {
    try {
      await mkdir(dirname(wiring.file.path), { recursive: true })
      await writeFile(wiring.file.path, wiring.file.contents)
    } catch (error) {
      // A missing per-session settings file must not become a fatal CLI argument.
      return {
        args: [],
        ...(wiring.env ? { env: wiring.env } : {}),
        degradedReason: error instanceof Error ? error.message : String(error),
        degradedKind: 'error',
      }
    }
  }
  return {
    args: wiring.args,
    ...(wiring.env ? { env: wiring.env } : {}),
    ...(degradedReason ? { degradedReason, degradedKind } : {}),
  }
}

const warnings = new WeakMap<object, Set<string>>()

/** The owner is machine-scoped, never session-scoped. Server dedupe uses code. */
export function reportInstrumentationDegradation(
  owner: object,
  harness: string,
  installation: InstalledTerminalInstrumentation,
  send: (message: DaemonMessage) => void,
): void {
  const reason = installation.degradedReason
  if (!reason) return
  const kind = installation.degradedKind ?? 'error'
  const code = `${harness}-hooks-${kind}`
  let seen = warnings.get(owner)
  if (!seen) {
    seen = new Set()
    warnings.set(owner, seen)
  }
  if (seen.has(code)) return
  seen.add(code)
  // POD-4076: the untrusted arm is installed-but-dead, not failed-to-install.
  // Name the /hooks remedy in the description the attention item shows first;
  // the generic "installation failed" sentence would be a lie for it.
  const description =
    kind === 'untrusted'
      ? `${harness} hooks are installed but Codex has not trusted them; approve them in Codex's /hooks flow. Sessions run poll-only until then.`
      : `${harness} hook installation failed; sessions can still start.`
  send({
    type: 'machineDiagnostic',
    code,
    title: `${harness} hooks unavailable`,
    description,
    body: `${harness} instrumentation unavailable: ${reason}. The session will start; hook observations may be missing.`,
  })
}
