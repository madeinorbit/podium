// The daemon's half of a launch's terms (POD-6858): Podium's grants for one
// session, and the generic steps before a harness process is created.

import { join } from 'node:path'
import type { AppliedTerms, HomeEdit, LaunchFile } from '@podium/harness'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { announceDriverSelection, reportLaunchTerms } from './control/session.js'
import type { HomeEditPorts } from './harness-home-edits.js'
import { type PrepareLaunchPorts, podiumGrantsFor, prepareLaunch } from './session-posture.js'

const STATE = '/var/podium-state'
const NO_MCP = { mcpServers: { supported: false as const, reason: 'mounts no MCP' } }

describe('podiumGrantsFor', () => {
  it("names the context's Podium CLI and this session's own uploads folder", () => {
    const grants = podiumGrantsFor({ stateRoot: STATE }, 'sess-a', NO_MCP, {
      env: { PODIUM_CLI_PATH: '/opt/podium/bin/podium' },
    })
    expect(grants.podiumCli).toEqual({ name: 'podium', path: '/opt/podium/bin/podium' })
    expect(grants.uploadsDir).toBe(join(STATE, 'uploads', 'sess-a'))
    // Never the parent folder, never another session's.
    expect(grants.uploadsDir).not.toBe(join(STATE, 'uploads'))
    const other = podiumGrantsFor({ stateRoot: STATE }, 'sess-b', NO_MCP, { env: {} })
    expect(other.uploadsDir).not.toBe(grants.uploadsDir)
    expect(grants.uploadsDir.startsWith(`${other.uploadsDir}`)).toBe(false)
  })

  it('names the bare CLI when the context carries no CLI path', () => {
    const grants = podiumGrantsFor({ stateRoot: STATE }, 'sess-a', NO_MCP, { env: {} })
    expect(grants.podiumCli).toEqual({ name: 'podium', path: 'podium' })
  })

  it("lists the server names the spec's MCP configuration declares", () => {
    const grants = podiumGrantsFor(
      { stateRoot: STATE },
      'sess-a',
      {
        mcpServers: {
          supported: true,
          value: {
            transport: 'inline',
            config: JSON.stringify({ mcpServers: { podium: {}, docs: {} } }),
          },
        },
      },
      { env: {} },
    )
    expect(grants.mcpServers).toEqual(['docs', 'podium'])
    expect(podiumGrantsFor({ stateRoot: STATE }, 'sess-a', NO_MCP, { env: {} }).mcpServers).toEqual(
      [],
    )
  })
})

const NO_SESSION = { noSession: 'a posture test serves no session' } as const

describe('prepareLaunch', () => {
  const trust: HomeEdit = {
    kind: 'json-key',
    file: '/home/u/.harness.json',
    path: ['projects', '/repo', 'trusted'],
    value: true,
    serves: 'workspace-trust',
  }
  const terms = (homeEdits: readonly HomeEdit[]): AppliedTerms => ({
    homeEdits,
    requestedMode: 'auto',
    unmet: [{ requirement: 'quiet-start', reason: 'no switch for the update menu' }],
  })

  function ports(homeEdits: HomeEditPorts): {
    ports: PrepareLaunchPorts
    written: LaunchFile[]
    logged: Record<string, unknown>[]
  } {
    const written: LaunchFile[] = []
    const logged: Record<string, unknown>[] = []
    return {
      written,
      logged,
      ports: {
        async writeLaunchFile(file) {
          written.push(file)
        },
        homeEdits,
        log: (_message, fields) => logged.push(fields),
      },
    }
  }

  it('turns a failed home edit into one unmet entry naming what it served, and resolves', async () => {
    const failing: HomeEditPorts = {
      readFile: async () => {
        throw new Error('EACCES: permission denied')
      },
      writeFileAtomic: async () => {
        throw new Error('unreachable')
      },
      createFileExclusive: async () => {
        throw new Error('unreachable')
      },
      log: () => {},
    }
    const file = { path: '/run/s/settings.json', contents: '{}' }
    const io = ports(failing)
    const applied = await prepareLaunch(
      { files: [file], terms: terms([trust]) },
      io.ports,
      NO_SESSION,
    )
    expect(io.written).toEqual([file])
    expect(applied.requestedMode).toBe('auto')
    expect(applied.homeEdits).toEqual([trust])
    expect(applied.unmet).toHaveLength(2)
    expect(applied.unmet[0]).toEqual({
      requirement: 'quiet-start',
      reason: 'no switch for the update menu',
    })
    expect(applied.unmet[1]?.requirement).toBe('workspace-trust')
    expect(applied.unmet[1]?.reason).toMatch(/EACCES/)
    expect(io.logged).toHaveLength(1)
  })

  it('adds nothing when every edit is made', async () => {
    let body = JSON.stringify({ other: 1 })
    const working: HomeEditPorts = {
      readFile: async () => body,
      writeFileAtomic: async (_path, contents) => {
        body = contents
      },
      createFileExclusive: async () => false,
      log: () => {},
    }
    const applied = await prepareLaunch(
      { files: [], terms: terms([trust]) },
      ports(working).ports,
      NO_SESSION,
    )
    expect(applied.unmet).toEqual([
      { requirement: 'quiet-start', reason: 'no switch for the update menu' },
    ])
    expect(JSON.parse(body)).toEqual({ other: 1, projects: { '/repo': { trusted: true } } })
  })
})

/**
 * THE APPLIED TERMS GO TO THE SERVER (POD-6858 Task 11): on the driver
 * decision, repeated with the same driver once the terms are known.
 */
describe('reportLaunchTerms', () => {
  const SESSION = asSessionId('44444444-4444-4444-8444-444444444444')
  const unmet = [{ requirement: 'autonomy' as const, reason: 'this harness has no approval gate' }]

  it('repeats the announced decision with the mode asked for and each unmet requirement', () => {
    const sent: unknown[] = []
    const ctx = { send: (m: unknown) => void sent.push(m) }
    announceDriverSelection(ctx as never, SESSION, 'codex-app-server')
    reportLaunchTerms(ctx as never, SESSION, { requestedMode: 'never', unmet })
    expect(sent).toEqual([
      { type: 'driverSelected', sessionId: SESSION, driverId: 'codex-app-server' },
      {
        type: 'driverSelected',
        sessionId: SESSION,
        driverId: 'codex-app-server',
        posture: { requestedMode: 'never', unmet },
      },
    ])
  })

  it('names the fallback driver when none was announced, and sends nothing with neither', () => {
    const other = asSessionId('55555555-5555-4555-8555-555555555555')
    const sent: Array<{ driverId?: string }> = []
    const ctx = { send: (m: { driverId?: string }) => void sent.push(m) }
    reportLaunchTerms(ctx as never, other, { requestedMode: null, unmet }, 'generic-pty')
    expect(sent.map((m) => m.driverId)).toEqual(['generic-pty'])
    reportLaunchTerms(ctx as never, other, { requestedMode: null, unmet })
    expect(sent).toHaveLength(1)
  })
})
