import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { DriverCapabilities, SessionSpec } from '@podium/agent-runtime'
import { agentStateProviderFor, harnessInstanceHomeEnv, manifestFor } from '@podium/harness'
import type { AgentKind, SessionId } from '@podium/model'
import { ensurePodiumCodexHooks } from '../codex-hooks'
import { ensurePodiumGrokHooks } from '../grok-hooks'

/** Ready-to-launch wiring. Files have already been written successfully. */
export interface InstalledTerminalInstrumentation {
  args: string[]
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
  if (manifest.capabilities.hookInstall === 'global-env') {
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
    const result = await serialized(`${spec.harness}:${harnessHome}`, async () => {
      if (spec.harness === 'codex') return ensurePodiumCodexHooks({ codexHome: harnessHome })
      if (spec.harness === 'grok') return ensurePodiumGrokHooks({ grokHome: harnessHome })
      throw new Error(`no global instrumentation installer for ${spec.harness}`)
    })
    if (!result.installed)
      throw new Error(`${spec.harness} instrumentation unavailable: ${result.reason}`)
  }
  const wiring = provider.instrumentation({
    ...channel,
    seedTheme: channel.seedTheme ?? true,
    settingsPath: join(input.settingsDir, `${input.sessionId}.json`),
  })
  if (wiring.file) {
    await mkdir(dirname(wiring.file.path), { recursive: true })
    await writeFile(wiring.file.path, wiring.file.contents)
  }
  return { args: wiring.args, ...(wiring.env ? { env: wiring.env } : {}) }
}
