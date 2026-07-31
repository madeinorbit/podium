import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asAgentIdentityId, asMachineId, asSessionId, asUserId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore } from './binding-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('binding receipt crash durability', () => {
  it.skipIf(process.platform === 'win32')(
    'replays an unacked process-ownership receipt after the daemon writer is SIGKILLed',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'podium-binding-crash-'))
      roots.push(root)
      const dir = join(root, 'instances', 'instance-a', 'runtime', 'session-bindings')
      const owner = asUserId('user:crash-owner')
      const sessionId = asSessionId('crash-pane')
      const store = await BindingStore.open({ dir })
      await store.ensureBinding({
        sessionId,
        agentKind: 'codex',
        claimantMachineId: asMachineId('machine-a'),
        delegation: {
          actor: asAgentIdentityId('agent-crash'),
          onBehalfOf: owner,
          grantedScope: { kind: 'owned', userId: owner },
          parentBindingId: null,
        },
      })

      const child = spawn(process.execPath, [
        '--conditions=@podium/source',
        join(import.meta.dirname, 'fixtures', 'binding-receipt-crash-writer.ts'),
        dir,
      ])
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      const deadline = Date.now() + 5_000
      while (!stdout.includes('receipt-durable')) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`crash writer exited before persistence: ${stderr}`)
        }
        if (Date.now() > deadline) {
          throw new Error(`crash writer did not persist its receipt: ${stderr}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      child.kill('SIGKILL')
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null]
      expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' })

      const restarted = await BindingStore.open({ dir })
      const sent: DaemonMessage[] = []
      expect(await restarted.replayPendingReceiptsForOwner(owner, (msg) => sent.push(msg))).toBe(1)
      expect(sent).toEqual([
        {
          type: 'sessionResumeRef',
          sessionId,
          resume: { kind: 'codex-thread', value: 'crash-thread' },
          confidence: 'exact',
          ackRequested: true,
        },
      ])
      expect((await restarted.read(sessionId))?.observations[0]).toMatchObject({
        channel: 'process-ownership',
        source: 'process',
        value: 'crash-thread',
        pendingServerAck: { nativeKind: 'codex-thread', value: 'crash-thread' },
      })

      expect(
        await restarted.acknowledgePendingReceipt(owner, sessionId, {
          kind: 'codex-thread',
          value: 'crash-thread',
        }),
      ).toBe(true)
      expect(await (await BindingStore.open({ dir })).pendingReceiptsForOwner(owner)).toEqual([])
    },
  )
})
