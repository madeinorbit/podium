import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveConfig } from '@podium/runtime/config'
import { reconcileSupervision } from './topology-reconcile'

const previousStateDir = process.env.PODIUM_STATE_DIR
const dirs: string[] = []

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = previousStateDir
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'podium-topo-'))
  dirs.push(root)
  process.env.PODIUM_STATE_DIR = root
  saveConfig({ mode: 'all-in-one', persistence: 'systemd' })
  const unitDir = join(root, 'units')
  const installed = new Set<string>([
    'podium-server.service',
    'podium-janitor.service',
    'podium-daemon.service',
  ])
  const enabled = new Set<string>(installed)
  const active = new Set<string>(installed)
  const masked = new Set<string>()
  const commands: string[] = []
  return {
    root,
    unitDir,
    commands,
    installed,
    enabled,
    deps: {
      instanceId: 'default',
      env: { ...process.env, PODIUM_STATE_DIR: root },
      unitDir: () => unitDir,
      listUnitFiles: () => [...installed],
      unitActive: (unit: string) => active.has(unit),
      unitEnabled: (unit: string) => enabled.has(unit),
      unitMasked: (unit: string) => masked.has(unit),
      writeUnit: (unit: string, body: string) => {
        commands.push(`write:${unit}`)
        expect(body).toContain('Type=notify')
        expect(body).toContain('WatchdogSec=90')
        expect(body).toContain('Restart=always')
        expect(body).toContain('parent --takeover')
        installed.add(unit)
        writeFileSync(join(root, unit), body)
        return join(root, unit)
      },
      enableUnits: (units: string[]) => {
        commands.push(`enable:${units.join(',')}`)
        for (const unit of units) enabled.add(unit)
      },
      startUnits: (units: string[]) => {
        commands.push(`start:${units.join(',')}`)
        for (const unit of units) active.add(unit)
      },
      maskUnits: (units: string[]) => {
        commands.push(`mask:${units.join(',')}`)
        for (const unit of units) masked.add(unit)
      },
      unmaskUnits: (units: string[]) => {
        commands.push(`unmask:${units.join(',')}`)
        for (const unit of units) masked.delete(unit)
      },
      disarmUnits: (units: string[]) => {
        commands.push(`disarm:${units.join(',')}`)
        for (const unit of units) enabled.delete(unit)
      },
      removeUnits: (units: string[]) => {
        commands.push(`remove:${units.join(',')}`)
        for (const unit of units) {
          installed.delete(unit)
          enabled.delete(unit)
          active.delete(unit)
          masked.delete(unit)
        }
      },
    },
  }
}

describe('reconcileSupervision', () => {
  it('a 3-unit VPS writes and starts podium.service, then waits — it does not retire yet', async () => {
    const { deps, commands, installed } = fixture()
    const result = await reconcileSupervision(deps)
    expect(result.actions).toEqual([
      'write-parent',
      'enable-parent',
      'mask-legacy',
      'start-parent',
      'await-healthy',
    ])
    expect(result.armed).toBe('both')
    expect(installed.has('podium.service')).toBe(true)
    expect(installed.has('podium-server.service')).toBe(true)
    expect(commands).toContain('write:podium.service')
    expect(commands.some((c) => c.startsWith('mask:'))).toBe(true)
  })

  it('retires leftover units only after the new parent is healthy', async () => {
    const { deps, installed } = fixture()
    const result = await reconcileSupervision({
      ...deps,
      parentHealthy: () => true,
    })
    expect(result.actions).toContain('retire-legacy')
    expect(result.actions.at(-1)).toBe('noop')
    expect([...installed]).toEqual(['podium.service'])
    expect(result.armed).toBe('new')
  })

  it('abort on health timeout leaves the legacy units enabled', async () => {
    const { deps, installed, enabled } = fixture()
    let t = 0
    const result = await reconcileSupervision({
      ...deps,
      now: () => t,
      healthTimeoutMs: 10,
      parentHealthy: () => {
        t = 11
        return false
      },
    })
    expect(result.actions).toContain('abort-keep-legacy')
    expect(result.armed).toBe('legacy')
    expect(installed.has('podium-server.service')).toBe(true)
    expect(enabled.has('podium-server.service')).toBe(true)
    expect(enabled.has('podium.service')).toBe(false)
  })

  it('re-running on a converged host is a no-op', async () => {
    const { deps, installed, enabled, commands } = fixture()
    installed.clear()
    enabled.clear()
    installed.add('podium.service')
    enabled.add('podium.service')
    // The parent unit is already the active supervisor.
    const active = new Set(['podium.service'])
    const result = await reconcileSupervision({
      ...deps,
      unitActive: (unit: string) => active.has(unit),
      parentHealthy: () => true,
      env: { PODIUM_UNDER_PARENT: '1', PODIUM_STATE_DIR: deps.env.PODIUM_STATE_DIR },
    })
    expect(result.actions).toEqual(['noop'])
    expect(commands).toEqual([])
  })

  it('foreground/unmanaged refuses rather than writing units', async () => {
    const { deps, commands } = fixture()
    saveConfig({ mode: 'all-in-one' })
    const result = await reconcileSupervision({
      ...deps,
      config: { mode: 'all-in-one' },
      env: { PODIUM_STATE_DIR: deps.env.PODIUM_STATE_DIR },
    })
    expect(result.actions).toEqual(['refuse-foreground'])
    expect(commands).toEqual([])
  })
})
