import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoveryRoots, type HarnessContext, harnessContext } from '@podium/harness'
import type { SessionSpec } from '@podium/harness/driver/host'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import * as processControl from '../control/session'
import { DaemonHarnessRuntime } from '../harness-runtime'
import { testHarnessSnapshot } from '../test-support/harness-snapshot'
import { daemonRuntimeHost } from './host'

describe('daemonRuntimeHost', () => {
  it('installs hooks and launches from the session context, whatever the inventory says now', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'podium-selected-hooks-'))
    const launch = vi
      .spyOn(processControl, 'launchTerminalProcess')
      .mockResolvedValue({ announce() {} })
    try {
      await mkdir(join(homeDir, '.codex'))
      const selectedBase = testHarnessSnapshot({ codex: '/opt/homebrew/bin/codex' }, 0)
      const executable = {
        kind: 'codex' as const,
        path: '/opt/homebrew/bin/codex',
        version: 'codex-cli 0.162.0',
        generation: 0,
      }
      const selected = { ...selectedBase, executables: new Map([['codex' as const, executable]]) }
      const replacement = testHarnessSnapshot({ codex: '/different/codex' }, 1)
      const harnessRuntime = new DaemonHarnessRuntime({
        buildSnapshot: async (generation) => (generation === 0 ? selected : replacement),
      })
      const ctx = {
        harnessRuntime,
        homeDir,
        settingsDir: join(homeDir, 'settings'),
      } as DaemonContext
      const host = daemonRuntimeHost(ctx, () => {})
      const specFor = (harnessContext: HarnessContext): SessionSpec => ({
        harness: 'codex',
        harnessContext,
        workdir: '/repo',
        model: {},
        selection: { auth: 'unknown', platform: 'darwin', available: [] },
        instructions: { supported: false, reason: 'fixture' },
        mcpServers: { supported: false, reason: 'fixture' },
        instrumentation: { endpointUrl: 'http://localhost/hooks/selected' },
      })
      const spec = specFor(harnessContext(await harnessRuntime.current(), 'codex', homeDir))
      const sessionId = asSessionId('selected-install')
      const instrumentation = await host.installInstrumentation(sessionId, spec)
      // The selected installation's version passes the hook gate.
      expect(instrumentation.degradedKind).toBe('untrusted')
      await harnessRuntime.refresh()
      // A session spawned after the refresh carries the replacement's context;
      // it must not disturb the first session's.
      const second = specFor(harnessContext(await harnessRuntime.current(), 'codex', homeDir))
      const secondWiring = await host.installInstrumentation(asSessionId('second-install'), second)
      await host.launch({ sessionId, spec, instrumentation })
      await host.launch({
        sessionId: asSessionId('second-install'),
        spec: second,
        instrumentation: secondWiring,
      })
      expect(launch.mock.calls[0]?.[1].spec).toBe(spec)
      expect(launch.mock.calls[1]?.[1].spec).toBe(second)
      expect(spec.harnessContext.installation.executable).toBe('/opt/homebrew/bin/codex')
      expect(second.harnessContext.installation.executable).toBe('/different/codex')
    } finally {
      launch.mockRestore()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it.each([
    'never-live',
    'teardown',
  ] as const)('carries a %s terminal queue abandonment on the daemon wire', (reason) => {
    // Abandonment is the daemon's own frame: it leaves on the daemon's full
    // send (ctx.send), never cast through the driver's narrowed port.
    const daemonSent: DaemonMessage[] = []
    const driverSent: unknown[] = []
    const ctx = {
      send: (message: DaemonMessage) => daemonSent.push(message),
    } as unknown as DaemonContext
    const host = daemonRuntimeHost(ctx, (message) => driverSent.push(message))
    const sessionId = asSessionId('session-1')

    host.onDrainAbandoned?.({
      sessionId,
      turns: [
        { id: 'msg-1', text: 'first', origin: 'mail' },
        { id: 'msg-2', text: 'second', origin: 'mail' },
      ],
      reason,
    })

    expect(daemonSent).toEqual([
      {
        type: 'runtimeQueueDrainAbandoned',
        reportId: expect.any(String),
        sessionId,
        turnIds: ['msg-1', 'msg-2'],
        reason,
      },
    ])
    expect(driverSent).toEqual([])
  })

  it('reads an archive path inside a transcript root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-host-archive-'))
    try {
      const roots = discoveryRoots(home)
      expect(roots.length).toBeGreaterThan(0)
      const root = roots[0] as string
      await mkdir(root, { recursive: true })
      const file = join(root, 'session.jsonl')
      await writeFile(file, '{"role":"user"}')
      const ctx = { homeDir: home } as unknown as DaemonContext
      const host = daemonRuntimeHost(ctx, () => {})
      await expect(host.readArchiveBytes(file)).resolves.toEqual(
        new TextEncoder().encode('{"role":"user"}'),
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses ../ traversal above the transcript roots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-host-archive-'))
    try {
      const roots = discoveryRoots(home)
      expect(roots.length).toBeGreaterThan(0)
      const root = roots[0] as string
      await mkdir(root, { recursive: true })
      const file = join(root, 'session.jsonl')
      await writeFile(file, '{"role":"user"}')
      const ctx = { homeDir: home } as unknown as DaemonContext
      const host = daemonRuntimeHost(ctx, () => {})
      await expect(host.readArchiveBytes(join(root, '..', '..', 'escape.jsonl'))).rejects.toThrow(
        /outside transcript roots/,
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses an absolute path outside the transcript roots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-host-archive-home-'))
    const outside = await mkdtemp(join(tmpdir(), 'podium-host-archive-out-'))
    try {
      const secret = join(outside, 'secret.jsonl')
      await writeFile(secret, '{"role":"user"}')
      const ctx = { homeDir: home } as unknown as DaemonContext
      const host = daemonRuntimeHost(ctx, () => {})
      await expect(host.readArchiveBytes(secret)).rejects.toThrow(/outside transcript roots/)
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
