import { harnessHomeVariable } from '@podium/harness'
import type { ResolvedHarnessInventory } from '@podium/harness/inventory'
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { installAgents } from './install-agents'
import { scriptedIO } from './setup-ui'

const snapshot = (own = false): ResolvedHarnessInventory =>
  ({
    inventory: { os: 'linux', arch: 'x64', agents: [], tools: [] },
    executables: new Map(
      own
        ? BUILTIN_HARNESS_KINDS.map((kind) => [
            kind,
            { kind, path: `/personal/${kind}`, generation: 1 },
          ])
        : [],
    ),
    commandEnvironment: { env: { PATH: '/machine/bin' } },
  }) as unknown as ResolvedHarnessInventory
const installed = async (kind: (typeof BUILTIN_HARNESS_KINDS)[number]) => ({
  outcome: 'installed' as const,
  kind,
  version: '2.0.0',
  number: 1,
  dir: '/state/harnesses/release',
  executable: '/state/harnesses/release/bin/tool',
  previous: null,
  swept: [],
})

describe('managed --agents requests', () => {
  it('records machine-setup and the instance harnesses directory for each explicit request', async () => {
    const install = vi.fn(installed)
    const { io } = scriptedIO([])
    expect(
      await installAgents(io, ['codex', 'grok'], {
        harnessesDir: '/instance/harnesses',
        snapshot: async () => snapshot(),
        install,
      }),
    ).toEqual([
      { id: 'codex', ok: true },
      { id: 'grok', ok: true },
    ])
    expect(install.mock.calls.map(([kind]) => kind)).toEqual(['codex', 'grok'])
    expect(install).toHaveBeenCalledWith(
      'codex',
      false,
      expect.objectContaining({
        requestedBy: 'machine-setup',
        harnessesDir: '/instance/harnesses',
        commandEnv: { PATH: '/machine/bin' },
      }),
    )
  })
  it.each(
    BUILTIN_HARNESS_KINDS.filter((kind) => !harnessHomeVariable(kind)),
  )('refuses %s alongside the person’s own install through the shared mechanism', async (kind) => {
    const { io } = scriptedIO([])
    const [result] = await installAgents(io, [kind], {
      snapshot: async () => snapshot(true),
      harnessesDir: '/not-written',
    })
    expect(result?.ok).toBe(false)
    expect(result?.detail).toContain('no folder variable')
  })
  it('keeps going after a failure and exposes its cause', async () => {
    const { io, output } = scriptedIO([])
    const result = await installAgents(io, ['codex', 'grok'], {
      snapshot: async () => snapshot(),
      install: async (kind) => {
        if (kind === 'codex') throw new Error('vendor unavailable')
        return installed(kind)
      },
    })
    expect(result.map((row) => row.ok)).toEqual([false, true])
    expect(output.join('\n')).toContain('vendor unavailable')
  })
  it('runs nothing when no harness was requested, and refuses unknown IDs', async () => {
    const read = vi.fn(async () => snapshot())
    const { io } = scriptedIO([])
    expect(await installAgents(io, [], { snapshot: read })).toEqual([])
    expect(read).not.toHaveBeenCalled()
    await expect(installAgents(io, ['emacs'], { snapshot: read })).rejects.toThrow('emacs')
  })
})
