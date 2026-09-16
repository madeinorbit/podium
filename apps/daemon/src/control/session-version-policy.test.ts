import { randomUUID } from 'node:crypto'
import {
  AGENT_MANIFESTS,
  CODEX_VERSION_POLICY,
  type DriverId,
  harnessVersionDiagnostic,
} from '@podium/harness'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexAppServerVersionProbe,
  resetCodexAppServerVersionProbe,
} from '../runtime/codex-app-server'
import { grokAcpVersionProbe, resetGrokAcpVersionProbe } from '../runtime/grok-acp-server'
import { opencodeVersionProbe, resetOpencodeVersionProbe } from '../runtime/opencode-server'
import type { DaemonContext } from './context'
import { launchServerDriverSession, reportHarnessVersionDiagnostic } from './session'

const cases = [
  {
    harness: 'codex',
    driver: 'codex-app-server',
    probe: codexAppServerVersionProbe,
    reset: resetCodexAppServerVersionProbe,
    newer: '0.154.0',
    old: '0.146.99',
    floor: '0.147',
  },
  {
    harness: 'opencode',
    driver: 'opencode-server',
    probe: opencodeVersionProbe,
    reset: resetOpencodeVersionProbe,
    newer: '2.0.0',
    old: '1.17.99',
    floor: '1.18',
  },
  {
    harness: 'grok',
    driver: 'grok-acp',
    probe: grokAcpVersionProbe,
    reset: resetGrokAcpVersionProbe,
    newer: '1.0.0',
    old: '0.2.22',
    floor: '0.2.23',
  },
] as const

afterEach(() => {
  for (const row of cases) row.reset()
})

function world(harness: 'codex' | 'opencode' | 'grok') {
  const sent: DaemonMessage[] = []
  const create = vi.fn(async () => {})
  const ctx = {
    machineId: randomUUID(),
    send: (message: DaemonMessage) => {
      sent.push(message)
    },
    harnessLoginState: () => 'in',
    agentRuntime: {
      // Use the real manifest selection policy; observe the driver given to create.
      resolveDriver: (input: { available: DriverId[]; requested: DriverId }) => ({
        ok: true,
        driverId: AGENT_MANIFESTS[harness].runtime.select({
          auth: 'subscription',
          platform: 'linux',
          available: input.available,
          preference: input.requested,
        }),
        capabilities: { placement: 'dedicated' },
      }),
      serverHandleFor: () => undefined,
      handleFor: () => undefined,
      adoptJournalled: async () => ({ found: false }),
      create,
    },
  } as unknown as DaemonContext
  return { ctx, sent, create }
}

describe.each(cases)('$harness floor-only session admission', (row) => {
  it.each([
    'newer',
    'unparseable',
    'timeout',
  ] as const)('starts the full driver for %s without an attention notice', async (scenario) => {
    const { ctx, sent, create } = world(row.harness)
    const output =
      scenario === 'newer'
        ? row.newer
        : scenario === 'timeout'
          ? 'probe timed out'
          : 'changed banner'
    const probe = () => row.probe(() => ({ output, ok: scenario !== 'timeout' }))
    for (let index = 0; index < 2; index += 1) {
      await launchServerDriverSession(
        ctx,
        {
          type: 'spawn',
          sessionId: `${scenario}-${index}`,
          agentKind: row.harness,
          cwd: '/tmp',
          geometry: { cols: 80, rows: 24 },
          runtimeContract: row.driver,
        } as never,
        probe,
      )
    }
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            selection: expect.objectContaining({ available: [row.driver], preference: row.driver }),
          }),
          expect.any(String),
        ],
      ]),
    )
    expect(sent.filter((message) => message.type === 'spawnError')).toEqual([])
    expect(sent.filter((message) => message.type === 'driverSelected')).toHaveLength(2)
    expect(
      sent
        .filter((message) => message.type === 'driverSelected')
        .every((message) => message.driverId === row.driver),
    ).toBe(true)
    const notices = sent.filter((message) => message.type === 'machineDiagnostic')
    expect(notices).toHaveLength(0)
  })

  it('refuses below the floor with the install instruction', async () => {
    const { ctx, sent, create } = world(row.harness)
    await launchServerDriverSession(
      ctx,
      {
        type: 'spawn',
        sessionId: 'too-old',
        agentKind: row.harness,
        cwd: '/tmp',
        geometry: { cols: 80, rows: 24 },
        runtimeContract: row.driver,
      } as never,
      () => row.probe(() => ({ output: row.old, ok: true })),
    )
    expect(create).not.toHaveBeenCalled()
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'spawnError',
        message: expect.stringContaining(`Install ${row.harness} ${row.floor} or newer`),
      }),
    )
  })
})

it('deduplicates by machine, harness and version, preserving distinct preview versions', () => {
  const first = world('codex')
  const second = world('codex')
  const diagnostic = {
    code: 'codex-version-too-old',
    title: 'Codex is too old',
    body: 'Install a newer Codex version.',
    observedVersion: 'codex-cli 0.146.0-beta.1',
  }
  reportHarnessVersionDiagnostic(first.ctx, 'codex', diagnostic)
  reportHarnessVersionDiagnostic(first.ctx, 'codex', {
    ...diagnostic,
    observedVersion: 'v0.146.0-beta.1',
  })
  reportHarnessVersionDiagnostic(first.ctx, 'codex', {
    ...diagnostic,
    observedVersion: '0.146.0-beta.2',
  })
  reportHarnessVersionDiagnostic(first.ctx, 'opencode', diagnostic)
  reportHarnessVersionDiagnostic(second.ctx, 'codex', diagnostic)
  expect(first.sent).toHaveLength(3)
  expect(second.sent).toHaveLength(1)
})

it('keeps unverified and unparseable observations quiet while still sending too-old diagnostics', () => {
  const { ctx, sent } = world('codex')
  for (const [output, code] of [
    ['0.154.0', 'codex-version-unverified'],
    ['probe timed out', 'codex-version-unparseable'],
  ] as const) {
    const diagnostic = harnessVersionDiagnostic('codex', CODEX_VERSION_POLICY, output)
    expect(diagnostic?.code).toBe(code)
    if (!diagnostic) throw new Error('expected an informational version observation')
    reportHarnessVersionDiagnostic(ctx, 'codex', diagnostic)
    expect(sent).toEqual([])
  }

  const tooOld = harnessVersionDiagnostic('codex', CODEX_VERSION_POLICY, '0.146.0')
  expect(tooOld?.code).toBe('codex-version-too-old')
  if (!tooOld) throw new Error('expected an actionable floor diagnostic')
  reportHarnessVersionDiagnostic(ctx, 'codex', tooOld)
  expect(sent).toEqual([{ type: 'machineDiagnostic', ...tooOld }])
})
