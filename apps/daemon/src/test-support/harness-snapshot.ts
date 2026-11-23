import type { ResolvedHarnessInventory } from '@podium/harness'
import type { BuiltinHarnessKind } from '@podium/protocol'

const defaults: Record<BuiltinHarnessKind, string> = {
  'claude-code': '/opt/claude',
  codex: '/opt/codex',
  grok: '/opt/grok',
  opencode: '/opt/opencode',
  cursor: '/opt/cursor-agent',
  pi: '/opt/pi',
  antigravity: '/opt/agy',
}

export function testHarnessSnapshot(
  paths: Partial<Record<BuiltinHarnessKind, string>> = {},
  generation = 1,
  /** Podium's installs (managed installs §6.1), by harness: release folder 1. */
  managedPaths: Partial<Record<BuiltinHarnessKind, string>> = {},
): ResolvedHarnessInventory {
  const all = { ...defaults, ...paths }
  const executables = new Map(
    Object.entries(all).map(([kind, path]) => [
      kind as BuiltinHarnessKind,
      { kind: kind as BuiltinHarnessKind, path, generation },
    ]),
  )
  const managed = new Map(
    Object.entries(managedPaths).map(([kind, path]) => [
      kind as BuiltinHarnessKind,
      { kind: kind as BuiltinHarnessKind, path, generation, release: 1 },
    ]),
  )
  const env = Object.freeze({ PATH: '/opt:/usr/bin:/bin', HOME: '/tmp' })
  return {
    inventory: {
      os: 'linux',
      arch: 'x64',
      podiumVersion: 'test',
      agents: [],
      tools: [],
    },
    executables,
    managed,
    commandEnvironment: {
      env,
      pathEntries: ['/opt', '/usr/bin', '/bin'],
      source: 'inherited',
      generation,
      machineHome: '/tmp',
      loginShell: '/bin/sh',
      resolve: (command) => all[command as BuiltinHarnessKind],
    },
  }
}
