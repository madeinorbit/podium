import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UninstallEditOutcome } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  installedCommandPath,
  instanceUnitNames,
  parseUninstallArgs,
  runUninstall,
  type UninstallOptions,
  type UninstallPorts,
  type UninstallTarget,
} from './uninstall-cli'

const OPTIONS: UninstallOptions = {
  yes: true,
  force: false,
  json: false,
  deleteWorkspaceData: false,
}

function fixture(over: Partial<UninstallTarget> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'podium-uninstall-'))
  const stateDir = join(root, 'state')
  const installDir = join(root, 'install')
  const commandPath = join(root, 'bin', 'podium')
  for (const dir of [stateDir, installDir, join(root, 'bin')]) mkdirSync(dir, { recursive: true })
  writeFileSync(commandPath, '')
  const target: UninstallTarget = {
    instanceId: 'default',
    machineName: 'build-box',
    mode: 'daemon',
    stateDir,
    installDir,
    commandPath,
    ...over,
  }
  return { target, stateDir, installDir, commandPath }
}

function ports(
  edits: UninstallEditOutcome[] | Error = [],
  over: Partial<UninstallPorts> = {},
): UninstallPorts & { steps: string[]; lines: string[] } {
  const steps: string[] = []
  const lines: string[] = []
  return {
    steps,
    lines,
    confirm: async (question) => {
      steps.push(`confirm:${question.split('\n')[0]}`)
      return true
    },
    stopServices: async () => {
      steps.push('stop')
      return []
    },
    undoHomeEdits: async () => {
      steps.push('undo')
      if (edits instanceof Error) throw edits
      return edits
    },
    removeServiceUnits: async () => {
      steps.push('units')
      return ['podium.service']
    },
    removePath: (path) => steps.push(`rm:${path}`),
    out: (line) => lines.push(line),
    ...over,
  }
}

const restored = (file: string): UninstallEditOutcome => ({
  harness: 'claude',
  file,
  status: 'restored',
})

describe('runUninstall', () => {
  it('confirms naming the machine, then stops, undoes, removes units, then removes files', async () => {
    const { target, stateDir, installDir, commandPath } = fixture()
    const p = ports([restored('/home/me/.claude/settings.json')])
    const report = await runUninstall({ ...OPTIONS, yes: false }, target, p)
    expect(p.steps).toEqual([
      'confirm:Uninstall Podium from build-box (instance default)?',
      'stop',
      'undo',
      'units',
      `rm:${stateDir}`,
      `rm:${installDir}`,
      `rm:${commandPath}`,
    ])
    expect(report?.kept).toEqual([])
    expect(p.lines).toContain('  1 restored, 0 changed since, 0 failed.')
    expect(p.lines.at(-1)).toBe('Podium is uninstalled from this machine.')
  })

  it('changes nothing when the person says no', async () => {
    const { target } = fixture()
    const p = ports([], { confirm: async () => false })
    expect(await runUninstall({ ...OPTIONS, yes: false }, target, p)).toBeUndefined()
    expect(p.steps).toEqual([])
    expect(p.lines).toEqual(['Nothing was changed.'])
  })

  it('keeps every Podium file when an edit was not undone, and says why', async () => {
    const { target, stateDir } = fixture()
    const p = ports([
      restored('/a'),
      { harness: 'codex', file: '/b', status: 'changed', reason: 'the key changed since' },
    ])
    const report = await runUninstall(OPTIONS, target, p)
    expect(p.steps).toEqual(['stop', 'undo', 'units'])
    expect(report?.kept.map((kept) => kept.path)).toEqual([
      stateDir,
      target.installDir,
      target.commandPath,
    ])
    expect(report?.kept[0]?.reason).toContain('--force')
    expect(p.lines).toContain('  changed since: /b (codex) — the key changed since')
  })

  it('removes the files anyway with --force', async () => {
    const { target, stateDir } = fixture()
    const p = ports([{ harness: 'codex', file: '/b', status: 'failed', reason: 'EACCES' }])
    const report = await runUninstall({ ...OPTIONS, force: true }, target, p)
    expect(p.steps).toContain(`rm:${stateDir}`)
    expect(report?.kept).toEqual([])
  })

  it('keeps the files when the record of edits could not be read', async () => {
    const { target } = fixture()
    const p = ports(new Error('ledger is newer'))
    const report = await runUninstall(OPTIONS, target, p)
    expect(report?.undoError).toBe('ledger is newer')
    expect(p.steps).toEqual(['stop', 'undo', 'units'])
  })

  it('keeps the files while a service is still running', async () => {
    const { target } = fixture()
    const p = ports([], { stopServices: async () => ['podium.service is still running.'] })
    const report = await runUninstall(OPTIONS, target, p)
    expect(report?.stopped).toBe(false)
    expect(p.steps).toEqual(['undo', 'units'])
    expect(report?.kept).toHaveLength(3)
  })

  it('keeps a server instance’s state folder unless workspace data is to go too', async () => {
    const { target, stateDir, installDir } = fixture({ mode: 'all-in-one' })
    const kept = ports([])
    const report = await runUninstall({ ...OPTIONS, yes: false }, target, kept)
    expect(kept.steps).toContain(`rm:${installDir}`)
    expect(kept.steps).not.toContain(`rm:${stateDir}`)
    expect(report?.kept).toEqual([
      { path: stateDir, reason: expect.stringContaining('--delete-workspace-data') },
    ])
    const gone = ports([])
    await runUninstall({ ...OPTIONS, deleteWorkspaceData: true }, target, gone)
    expect(gone.steps).toContain(`rm:${stateDir}`)
  })

  it('prints one JSON report with --json', async () => {
    const { target } = fixture()
    const p = ports([restored('/a')])
    await runUninstall({ ...OPTIONS, json: true }, target, p)
    expect(p.lines).toHaveLength(1)
    expect(JSON.parse(p.lines[0] ?? '')).toMatchObject({
      machine: 'build-box',
      edits: [{ file: '/a', status: 'restored' }],
      removedUnits: ['podium.service'],
    })
  })
})

describe('parseUninstallArgs', () => {
  it('reads the flags and refuses anything else', () => {
    expect(parseUninstallArgs(['--yes', '--force', '--delete-workspace-data'])).toEqual({
      yes: true,
      force: true,
      json: false,
      deleteWorkspaceData: true,
    })
    expect(parseUninstallArgs(['-y'])).toMatchObject({ yes: true })
    expect(parseUninstallArgs(['--forse'])).toMatchObject({ error: expect.any(String) })
    expect(parseUninstallArgs(['now'])).toMatchObject({ error: expect.stringContaining('now') })
  })
})

describe('installedCommandPath', () => {
  it('names the command only while it is still Podium’s', () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-home-'))
    const installDir = join(home, '.local', 'share', 'podium')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    mkdirSync(installDir, { recursive: true })
    expect(installedCommandPath('default', installDir, home)).toBeUndefined()
    symlinkSync(join(installDir, 'podium'), join(home, '.local', 'bin', 'podium'))
    expect(installedCommandPath('default', installDir, home)).toBe(
      join(home, '.local', 'bin', 'podium'),
    )
    // Someone else's program under the same name is left alone.
    expect(installedCommandPath('default', join(home, 'elsewhere'), home)).toBeUndefined()
    // A named instance's launcher.
    const named = join(home, '.local', 'share', 'podium-instances', 'lab')
    writeFileSync(
      join(home, '.local', 'bin', 'podium-lab'),
      `#!/bin/sh\nexport PODIUM_INSTANCE=lab\nexec "${named}/podium" "$@"\n`,
    )
    expect(installedCommandPath('lab', named, home)).toBe(join(home, '.local', 'bin', 'podium-lab'))
    expect(installedCommandPath('lab', installDir, home)).toBeUndefined()
  })
})

describe('instanceUnitNames', () => {
  it('names the parent, the tunnel and every legacy unit of the instance', () => {
    const units = instanceUnitNames('default')
    expect(units).toContain('podium.service')
    expect(units).toContain('podium-tunnel.service')
    expect(units).toContain('podium-daemon.service')
    expect(instanceUnitNames('lab')).toContain('podium-lab.service')
    expect(instanceUnitNames('lab').every((unit) => unit.startsWith('podium-lab'))).toBe(true)
  })
})
