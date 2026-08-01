import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAgentIdentityId,
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type SessionId,
} from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentCommandPrincipal } from '../../server/src/command-principal'
import { machineUseDecision, ownershipFromMachines } from '../../server/src/machine-access'
import { BindingStore } from './binding-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('binding receipt crash durability', () => {
  it.skipIf(process.platform === 'win32')(
    're-derives every live binding and an unacked receipt after the daemon is SIGKILLed',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'podium-binding-crash-'))
      roots.push(root)
      const dir = join(root, 'instances', 'instance-a', 'runtime', 'session-bindings')
      const owner = asUserId('user:crash-owner')
      const machineOwner = asUserId('user:machine-owner')
      const machineId = asMachineId('machine-a')
      const issueId = asIssueId('issue:crash-recovery')
      const sessions = [
        {
          sessionId: asSessionId('crash-pane'),
          agentKind: 'codex' as const,
          attemptId: 'attempt-crash-pane',
          actor: asAgentIdentityId('agent-crash'),
          scope: { kind: 'owned' as const, userId: owner },
        },
        {
          sessionId: asSessionId('narrow-pane'),
          agentKind: 'claude-code' as const,
          attemptId: 'attempt-narrow-pane',
          actor: asAgentIdentityId('agent-narrow'),
          scope: { kind: 'subtree' as const, rootId: issueId },
        },
        {
          sessionId: asSessionId('shell-pane'),
          agentKind: 'shell' as const,
          attemptId: 'attempt-shell-pane',
          actor: asAgentIdentityId('agent-shell'),
          scope: { kind: 'none' as const },
        },
      ]
      const store = await BindingStore.open({ dir })
      for (const session of sessions) {
        await store.ensureBinding({
          sessionId: session.sessionId,
          agentKind: session.agentKind,
          claimantMachineId: machineId,
          attemptId: session.attemptId,
          delegation: {
            actor: session.actor,
            onBehalfOf: owner,
            grantedScope: session.scope,
            parentBindingId: null,
          },
        })
      }
      await store.observe({
        sessionId: asSessionId('narrow-pane'),
        channel: 'provider-session',
        value: 'claude-native-crash',
        nativeKind: 'claude-session',
        confidence: 'exact',
        source: 'adapter-observer',
        observedAt: '2026-07-31T19:59:00.000Z',
      })
      await store.observe({
        sessionId: asSessionId('shell-pane'),
        channel: 'cwd',
        value: '/durable/shell/worktree',
        confidence: 'exact',
        source: 'control',
        observedAt: '2026-07-31T19:59:01.000Z',
      })

      const delegationBeforeCrash = new Map<string, string>()
      for (const session of sessions) {
        delegationBeforeCrash.set(
          session.sessionId,
          JSON.stringify((await store.read(session.sessionId))?.delegationHistory),
        )
      }

      // Exercise POD-1079's real, live grant resolver. This capability exists
      // only for an apply; it is intentionally never handed to BindingStore.
      let grants = [
        { grantee: owner, verb: 'see' },
        { grantee: owner, verb: 'use' },
      ]
      const ownership = ownershipFromMachines({
        ownershipRows: () => [{ id: machineId, ownerUserId: machineOwner }],
        grantsForMachine: () => grants,
      })
      const principalForApply = async (
        bindings: BindingStore,
        sessionId: SessionId,
      ): Promise<AgentCommandPrincipal> => {
        const binding = await bindings.read(sessionId)
        const delegation = binding && bindings.currentDelegation(binding)
        if (!binding || !delegation) throw new Error(`missing delegation for ${sessionId}`)
        return {
          kind: 'agent',
          agentSessionId: sessionId,
          onBehalfOf: delegation.onBehalfOf,
          capability: {
            role: 'worker',
            scope: delegation.grantedScope,
            actorSessionId: sessionId,
          },
          chain: [],
        }
      }
      expect(
        machineUseDecision(
          await principalForApply(store, asSessionId('narrow-pane')),
          machineId,
          ownership,
        ),
      ).toBe('granted')

      const child = spawn('bun', [
        '--conditions=@podium/source',
        join(import.meta.dirname, 'fixtures', 'binding-receipt-crash-writer.ts'),
        dir,
      ])
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      const receiptDurable = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`crash writer did not persist its receipt: ${stderr}`))
        }, 5_000)
        const finish = (error?: Error): void => {
          clearTimeout(timeout)
          if (error) reject(error)
          else resolve()
        }
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
          if (stdout.includes('receipt-durable')) finish()
        })
        child.once('exit', () => {
          if (!stdout.includes('receipt-durable')) {
            finish(new Error(`crash writer exited before persistence: ${stderr}`))
          }
        })
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      await receiptDurable
      child.kill('SIGKILL')
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null]
      expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' })

      // The human loses the use grant while the daemon is down. Recovery still
      // restores the delegation reference; the first apply resolves this table
      // again and refuses it.
      grants = []

      const restarted = await BindingStore.open({ dir })
      const sent: DaemonMessage[] = []
      expect(await restarted.replayPendingReceiptsForOwner(owner, (msg) => sent.push(msg))).toBe(1)
      expect(sent).toEqual([
        {
          type: 'sessionResumeRef',
          sessionId: asSessionId('crash-pane'),
          resume: { kind: 'codex-thread', value: 'crash-thread' },
          confidence: 'exact',
          ackRequested: true,
        },
      ])
      expect((await restarted.read(asSessionId('crash-pane')))?.observations[0]).toMatchObject({
        channel: 'process-ownership',
        source: 'process',
        value: 'crash-thread',
        pendingServerAck: { nativeKind: 'codex-thread', value: 'crash-thread' },
      })

      for (const session of sessions) {
        const outcome = await restarted.transition({
          event: 'reattach',
          transitionId: `restart:${session.sessionId}:2`,
          sessionId: session.sessionId,
          claimantMachineId: machineId,
          machineAccess: 'allowed',
          sessionAccess: 'allowed',
          principal: { kind: 'system' },
          requestedGeneration: 2,
        })
        expect(outcome.status).toBe('applied')
        if (outcome.status !== 'applied') throw new Error(`failed to rebind ${session.sessionId}`)
        expect(outcome.binding.attemptId).toBe(session.attemptId)
        expect(JSON.stringify(outcome.binding.delegationHistory)).toBe(
          delegationBeforeCrash.get(session.sessionId),
        )
      }

      expect((await restarted.read(asSessionId('narrow-pane')))?.observations).toContainEqual(
        expect.objectContaining({ value: 'claude-native-crash' }),
      )
      expect((await restarted.read(asSessionId('shell-pane')))?.observations).toContainEqual(
        expect.objectContaining({ value: '/durable/shell/worktree' }),
      )
      expect(
        restarted.currentDelegation((await restarted.read(asSessionId('narrow-pane')))!)
          ?.grantedScope,
      ).toEqual({ kind: 'subtree', rootId: issueId })

      const serialized = await Promise.all(
        sessions.map((session) =>
          readFile(
            join(dir, 'bindings', `${Buffer.from(session.sessionId).toString('base64url')}.json`),
            'utf8',
          ),
        ),
      )
      expect(serialized.join('\n')).not.toMatch(
        /"(?:capability|effectiveRights|rights|permission|permissions|role|acl)"\s*:/i,
      )
      expect(
        machineUseDecision(
          await principalForApply(restarted, asSessionId('narrow-pane')),
          machineId,
          ownership,
        ),
      ).toBe('denied')

      expect(
        await restarted.acknowledgePendingReceipt(owner, asSessionId('crash-pane'), {
          kind: 'codex-thread',
          value: 'crash-thread',
        }),
      ).toBe(true)
      expect(await (await BindingStore.open({ dir })).pendingReceiptsForOwner(owner)).toEqual([])
    },
  )
})
