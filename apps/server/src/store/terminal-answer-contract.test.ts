import { asThreadId, firstAdminMemberId, type SessionId } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { createTerminalRuntime, type TerminalRuntimeHost } from '../../../daemon/src/runtime/terminal-driver'
import { terminalProfileFor } from '../../../daemon/src/runtime/registry'
import { runtimeHandlers } from '../../../daemon/src/runtime/handlers'
import type { DaemonContext } from '../../../daemon/src/control/context'
import { userCommandPrincipal } from '../command-principal'
import { sessionCommandCtx } from '../modules/sessions/command-ctx'
import { dispatchSessionCommand } from '../modules/sessions/command-plane'
import { inboxPrincipalFromCommand } from '../modules/sessions/inbox'
import { buildSuperagentTools } from '../modules/superagent/tools'
import { deliverAnswerToSession } from '../modules/superagent/answer-delivery'
import { SessionRegistry } from '../relay'
import { openTestStore } from '../test-support/open-test-store'

describe('production terminal answer identity', () => {
  it('observes, admits, persists and answers the driver ID through the public command and RPC', async () => {
    const store = await openTestStore(':memory:')
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const writes: string[] = []
    const frames: DaemonMessage[] = []
    let ingress = Promise.resolve()
    const send = (msg: DaemonMessage): void => {
      frames.push(msg)
      ingress = ingress.then(() => registry.gateway.routeDaemonFrame(store.hostMachineId, msg))
    }
    const bridge = { pid: 789, write: (data: string) => writes.push(Buffer.from(data, 'base64').toString()) }
    const host = {
      send, bridge: () => bridge, now: () => Date.now(),
      durableLabel: (id: SessionId) => `answer-test-${id}`, scopeUnit: () => undefined,
      trackedState: () => undefined, draftSyncing: () => false,
      readTranscript: async () => [],
      setTimer: (fn: () => void, delay: number) => setTimeout(fn, delay),
      clearTimer: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    } as unknown as TerminalRuntimeHost
    const runtime = createTerminalRuntime(host)
    const daemon = { agentRuntime: runtime, send } as unknown as DaemonContext
    try {
      await store.machines.upsertMachine({ id: store.hostMachineId, name: 'Host', hostname: 'test',
        tokenHash: 'test', ownerUserId: firstAdminMemberId(), assignment: { server: true, agentExecution: true } })
      await registry.gateway.attachDaemon(store.hostMachineId, (msg) => {
        if (msg.type === 'runtimeAnswerRequest') runtimeHandlers.runtimeAnswerRequest(daemon, msg)
      })
      const { sessionId } = await registry.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/project' })
      const profile = terminalProfileFor('claude-code')!
      await registry.gateway.routeDaemonFrame(store.hostMachineId, { type: 'bind', sessionId,
        cmd: 'claude', cwd: '/project', agentKind: 'claude-code', geometry: { cols: 80, rows: 24 },
        runtimeContract: true, driverId: profile.driverId })
      const handle = runtime.register({ sessionId, agentKind: 'claude-code', cwd: '/project', resume: null }, profile)
      const observation = (transitionId: string, preview = true): AgentObservation => ({
        podiumSessionId: sessionId, provider: 'claude-code', providerSessionId: 'native',
        bindingVersion: 1, providerTurnId: null, providerPromptId: null, observerGeneration: 1,
        providerCursor: { segmentId: 'terminal-answer', components: { seq: frames.length + 1 } },
        providerAt: new Date().toISOString(), receivedAt: new Date().toISOString(), sourceEventKind: 'test-observation',
        transitionKind: 'needs_user', provenance: 'live', inputOrigin: 'human', turnEpoch: 1,
        priorPhase: 'working', nextPhase: 'needs_user', transitionId,
        state: { phase: 'needs_user', since: new Date().toISOString(), nativeSubagentCount: 0,
          need: { kind: 'question', summary: 'Pick', interview: { questions: [
            { question: 'Pick', options: [{ label: 'One', ...(preview ? { preview: 'One preview' } : {}) }, { label: 'Two' }] },
          ] } } },
      })
      const observe = async (id: string) => {
        runtime.observe({ type: 'agentObservation', observation: observation(id) })
        await ingress
        await registry.modules.sessions.runtimeEventGate.replayBoardProjection()
      }
      await observe('first')
      const first = (await handle.interactions())[0]!
      const open = await registry.modules.interactions.listOpen(sessionId)
      expect(open).toHaveLength(1)
      expect(open[0]).toMatchObject({ id: first.id, answerable: 'keystroke-emulated', source: first.source })
      const askFrame = frames.find((f) => f.type === 'runtimeEvent' && f.event.t === 'interaction' && f.event.ev.ev === 'asked')!
      await registry.gateway.routeDaemonFrame(store.hostMachineId, askFrame)
      expect(await registry.modules.interactions.listOpen(sessionId)).toHaveLength(1)
      const principal = userCommandPrincipal(firstAdminMemberId(), 'admin')
      const ctx = await sessionCommandCtx(registry.modules, principal.capability)
      expect(await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
        sessionId, interactionId: first.id, choices: [{ optionIndices: [1], previewLayout: true }],
      })).toEqual({ ok: true })
      await ingress
      expect(writes).toEqual(['1', '\r'])
      expect(await registry.modules.interactions.listOpen(sessionId)).toEqual([])
      const settled = (await registry.modules.interactions.listForSession(sessionId)).find((row) => row.id === first.id)
      expect(settled).toMatchObject({ status: 'answered', deliveredVia: 'menu', answeredBy: 'human' })
      expect(frames.some((f) => f.type === 'runtimeEvent' && f.event.t === 'interaction' && f.event.ev.ev === 'answered' && f.event.ev.id === first.id && f.event.ev.answeredBy === 'human')).toBe(true)

      await observe('second')
      const second = (await handle.interactions())[0]!
      await observe('third')
      expect(await registry.modules.interactions.listOpen(sessionId)).toHaveLength(1)
      expect(await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
        sessionId, interactionId: second.id, choices: [{ optionIndices: [2] }],
      })).toMatchObject({ ok: false })
      expect(await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
        sessionId, choices: [{ optionIndices: [2] }],
      })).toMatchObject({ ok: false })
      expect(writes).toEqual(['1', '\r'])
      // The shared superagent/relay helper captures the same aggregate identity.
      const result = await deliverAnswerToSession({
        getSession: (id) => registry.modules.sessions.sessionById(id),
        sessions: registry.modules.sessions,
        rpc: { readTranscript: async () => { throw new Error('must read the authoritative row') } },
      }, { sessionId, answer: 'Two', principal: inboxPrincipalFromCommand(principal) })
      expect(result).toMatchObject({ ok: true, via: 'menu' })
      expect(writes).toEqual(['1', '\r', '2', '\r'])
      host.readTranscript = async () => [{ id: 'tool-ask', role: 'tool', toolName: 'AskUserQuestion',
        ts: new Date().toISOString(), text: '', toolInputJson: JSON.stringify({ questions: [
          { question: 'Pick', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }] },
        ] }) }]
      const enrichedObservation = observation('enriched')
      enrichedObservation.state.need = { kind: 'question', summary: 'Pick' }
      runtime.observe({ type: 'agentObservation', observation: enrichedObservation })
      await Promise.resolve()
      await ingress
      await registry.modules.sessions.runtimeEventGate.replayBoardProjection()
      const enriched = (await handle.interactions())[0]!
      expect(enriched).toMatchObject({ kind: 'question', payload: { questions: [{ multiSelect: true }] } })
      expect(await registry.modules.interactions.listOpen(sessionId)).toMatchObject([
        { id: enriched.id, payload: enriched.payload },
      ])
      expect(await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
        sessionId, interactionId: enriched.id, choices: [{ optionIndices: [1, 2], multiSelect: true }],
      })).toEqual({ ok: true })
      expect(writes.slice(-4)).toEqual(['1', '2', '\t', '\r'])
      await observe('skip')
      const skipped = (await handle.interactions())[0]!
      expect(await dispatchSessionCommand(ctx, 'answerAskUserQuestion', { sessionId, interactionId: skipped.id, skip: true })).toEqual({ ok: true })
      expect(writes.at(-1)).toBe('\x1b')
      // The older matching transcript is multi-select; it must not overwrite
      // a replacement menu whose current observation says preview layout.
      await observe('notes')
      const notes = (await handle.interactions())[0]!
      expect(await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
        sessionId, interactionId: notes.id, choices: [{ freeText: 'Custom note', otherIndex: 3, previewLayout: true }],
      })).toEqual({ ok: true })
      expect(writes.slice(-3)).toEqual(['n', 'Custom note', '\r'])
      await observe('tool')
      const threadId = asThreadId('answer-contract-tool')
      await store.superagent.upsertSuperagentThread({ id: threadId, ownerUserId: firstAdminMemberId(), kind: 'global' })
      await store.superagent.updateSuperagentThreadBinding(threadId, { podiumSessionId: sessionId })
      const tools = await buildSuperagentTools({ modules: registry.modules, store, repos: { list: async () => [] }, waitPollMs: 5 }, '', threadId, { issueBelt: false })
      const tool = tools.find((tool) => tool.spec.name === 'answer_question')!
      const toolResult = await tool.run({ sessionId, answer: 'One' })
      expect(JSON.parse(toolResult)).toMatchObject({ answered: true })
      expect(writes.slice(-2)).toEqual(['1', '\r'])
      expect(frames.some((f) => f.type === 'runtimeEvent' && f.event.t === 'interaction' && f.event.ev.ev === 'answered' && f.event.ev.answeredBy === 'superagent')).toBe(true)


    } finally {
      runtime.dispose()
      await ingress
      await registry.dispose()
      await store.close()
    }
  })
})
