import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { createDurableProcess, killHostSession, resolveHostBin, spawnHostAgent } from '@podium/process/durable'
import type { DurableAttachment } from '@podium/process/screen'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { expect, it } from 'vitest'
import { daemonRuntimeHost } from '../runtime/host'
import { terminalProfileFor } from '../runtime/registry'
import { createTerminalRuntime } from '@podium/harness/driver/host'
import { driverSlotsOver } from '../session/driver-slots.js'
import { forgetSessionScreen, snapshotLines } from '../session-screens'
import type { DaemonContext } from './context'
import { testSessions } from '../session/testing.js'

it('rebuilds the screen from a durable survivor, and a link-B reattach never signals the existing bridge (POD-4723)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'terminal-recovery-'))
  const keys = ['PODIUM_HOST_SOCKET_DIR', 'PODIUM_STATE_DIR', 'PODIUM_NO_SCOPE'] as const
  const saved = keys.map((key) => process.env[key])
  process.env.PODIUM_HOST_SOCKET_DIR = join(root, 'sockets')
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.PODIUM_NO_SCOPE = '1'
  const sessionId = asSessionId(`recovery-${process.pid}`)
  const label = `podium-${sessionId}`
  const painted = `RECOVERY SCREEN ${'x'.repeat(80)}`
  let born: DurableAttachment | undefined
  let ctx: DaemonContext | undefined
  try {
    const fixture = join(root, 'screen.mjs')
    writeFileSync(
      fixture,
      `
      const draw = () => process.stdout.write('\\x1b[2J\\x1b[H${painted}');
      process.on('SIGWINCH', draw);
      draw();
      setInterval(() => {}, 1000);
    `,
    )
    resolveHostBin({ fresh: true })
    born = await spawnHostAgent({
      label,
      cmd: process.execPath,
      args: [fixture],
      cols: 101,
      rows: 31,
    })
    let output = ''
    born.onFrame((frame) => {
      output += Buffer.from(frame.data).toString()
    })
    await expect.poll(() => output).toContain('RECOVERY SCREEN')
    born.dispose() // daemon-side connection dies; the exact durable process survives
    const sent: DaemonMessage[] = []
    let redrawFrames = 0
    ctx = {
      backend: 'host',
      durable: createDurableProcess(),
      settingsDir: join(root, 'settings'),
      sessions: testSessions(),
      durableLabelFor: () => label,
      composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
      outputScheduler: {
        enqueue: () => {
          redrawFrames += 1
        },
        remove: () => {},
        priorityOf: () => 1,
      },
      observers: {
        trackedState: () => undefined,
        initSessionObservers: () => {},
        onResize: () => {},
        clearSession: () => {},
      },
      sessionCwdTracker: { clear: () => {}, setLaunchCwd: () => {} },
      reattachGate: (fn: () => Promise<void>) => fn(),
      tailSeedGate: () => {},
      send: (msg: DaemonMessage) => sent.push(msg),
    } as unknown as DaemonContext
    const host = daemonRuntimeHost(ctx, ctx.send)
    const runtime = createTerminalRuntime(host, undefined, driverSlotsOver(ctx.sessions))
    const send = ctx.send
    ctx.send = (msg) => {
      runtime.observe(msg)
      send(msg)
    }
    ctx.agentRuntime = { handleFor: runtime.handleFor, has: runtime.has } as NonNullable<
      DaemonContext['agentRuntime']
    >
    const msg = {
      type: 'reattach' as const,
      sessionId,
      durableLabel: label,
      agentKind: 'claude-code' as const,
      cwd: root,
      lastKnownGeometry: { cols: 80, rows: 24 },
      observationGeneration: 2,
      observationBindingVersion: 2,
    }
    const recovered = await runtime.recoverWithId(msg, terminalProfileFor('claude-code')!)
    // POD-4785 (c9283ef14): bindings are keyed by sessionId now — the driver
    // never resolves durable labels itself, the daemon does per session. The
    // durable label still travels on the reattach message (msg.durableLabel).
    expect(recovered.binding.process.key).toBe(sessionId)
    await expect
      .poll(() => snapshotLines(ctx!, sessionId)?.lines.join('\n') ?? '', { timeout: 5000 })
      .toContain(painted)
    const bridge = ctx.sessions.get(sessionId)?.terminal
    const before = redrawFrames
    await runtime.recoverWithId(
      { ...msg, observationGeneration: 3, observationBindingVersion: 3 },
      terminalProfileFor('claude-code')!,
    )
    expect(ctx.sessions.get(sessionId)?.terminal).toBe(bridge)
    // The fixture repaints on every SIGWINCH: the deleted reattach nudge made it
    // draw again here. Nothing may reach the program on a link-B reattach.
    await new Promise((r) => setTimeout(r, 1500))
    expect(redrawFrames).toBe(before)
    expect(sent.filter((frame) => frame.type === 'bind')).toHaveLength(2)
    expect((await recovered.snapshot()).observerGeneration).toBe(3)
    runtime.dispose()
  } finally {
    born?.dispose()
    for (const [, owned] of ctx?.sessions.entries() ?? []) owned.park()
    if (ctx) forgetSessionScreen(ctx, sessionId)
    await killHostSession(label)
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    })
    resolveHostBin({ fresh: true })
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
