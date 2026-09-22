// packages/harness/src/driver/families/headless/test-support.ts
//
// A resolved inventory for the headless family's tests: every built-in
// harness at a fixed fake path, overridable per test (a stand-in binary).

import type { BuiltinHarnessKind } from '@podium/protocol'
import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'

const defaults: Record<BuiltinHarnessKind, string> = {
  'claude-code': '/opt/claude',
  codex: '/opt/codex',
  grok: '/opt/grok',
  opencode: '/opt/opencode',
  cursor: '/opt/cursor-agent',
  pi: '/opt/pi',
}

export function testHarnessSnapshot(
  paths: Partial<Record<BuiltinHarnessKind, string>> = {},
  generation = 1,
): ResolvedHarnessInventory {
  const all = { ...defaults, ...paths }
  const executables = new Map(
    Object.entries(all).map(([kind, path]) => [
      kind as BuiltinHarnessKind,
      { kind: kind as BuiltinHarnessKind, path, generation },
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
    commandEnvironment: {
      env,
      pathEntries: ['/opt', '/usr/bin', '/bin'],
      source: 'inherited',
      generation,
      machineHome: '/tmp',
      loginShell: '/bin/sh',
      resolve: (command) => all[command as BuiltinHarnessKind],
    },
  } as ResolvedHarnessInventory
}
