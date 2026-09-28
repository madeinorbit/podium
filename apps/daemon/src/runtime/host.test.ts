import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoveryRoots } from '@podium/harness'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from '../control/context'
import { daemonRuntimeHost } from './host'

describe('daemonRuntimeHost', () => {
  it.each([
    'never-live',
    'teardown',
  ] as const)('carries a %s terminal queue abandonment on the daemon wire', (reason) => {
    // Abandonment is the daemon's own frame: it leaves on the daemon's full
    // send (ctx.send), never cast through the driver's narrowed port.
    const daemonSent: DaemonMessage[] = []
    const driverSent: unknown[] = []
    const ctx = { send: (message: DaemonMessage) => daemonSent.push(message) } as unknown as DaemonContext
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
