import {
  FIRST_ADMIN_USER_ID,
  type ConversationSummaryWire,
  type ConversationSummaryWireInput,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { attachTestClient } from './test-support/client-transport'

// Registry wiring at the observation seams (docs/spec/conversation-registry.md):
// scans mint identities + enrich the wire, sessionResumeRef stamps sessions and
// links live-rolls, and identity survives across the roll.
describe('SessionRegistry conversation registry', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  function makeRegistry(): SessionRegistry {
    const registry = new SessionRegistry()
    registries.push(registry)
    return registry
  }

  const conv = (
    id: string,
    extra: Partial<ConversationSummaryWireInput> = {},
  ): ConversationSummaryWire =>
    ({ id, agentKind: 'claude-code', providerId: 'claude-code-jsonl', ...extra }) as never

  it('scan mints podium ids, enriches broadcasts, and resolves subagent parents', () => {
    const registry = makeRegistry()
    registry.gateway.attachDaemon('m1', () => {})
    for (const conversationId of ['parent-1', 'sub-1']) {
      const { sessionId } = registry.modules.sessions.createSession({
        agentKind: 'claude-code',
        cwd: '/owned/' + conversationId,
      })
      registry.gateway.routeDaemonFrame('m1', {
        type: 'sessionResumeRef',
        sessionId,
        resume: { kind: 'claude-session', value: conversationId },
      })
    }
    registry.modules.sessions.flushBroadcasts()
    const inbox: ServerMessage[] = []
    const clientId = attachTestClient(registry.clientGateway, (m) => inbox.push(m))
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'hello',
      wireVersion: 2,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    inbox.length = 0
    registry.gateway.routeDaemonFrame('m1', {
      type: 'conversationsChanged',
      conversations: [conv('parent-1'), conv('sub-1', { parentConversationId: 'parent-1' })],
      diagnostics: [],
    })
    // Serving is coalesced onto the microtask boundary (POD-1203); this is the
    // deterministic seam. Without it the last `conversationsChanged` in the inbox
    // is still the one the ATTACH produced, before the scan committed anything.
    registry.modules.funnel.flushDeltas()
    const byId = new Map(
      inbox
        .flatMap((message) => (message.type === 'feedDelta' ? message.changes : []))
        .filter((change) => change.entity === 'conversation' && change.op === 'upsert')
        .map((change) => {
          const conversation = change.value as ConversationSummaryWire
          return [conversation.id, conversation] as const
        }),
    )
    const parent = byId.get('parent-1')
    const sub = byId.get('sub-1')
    expect(parent?.podiumId).toMatch(/^conv_/)
    expect(sub?.podiumId).toMatch(/^conv_/)
    expect(sub?.podiumId).not.toBe(parent?.podiumId)

    // Re-scan: identities are stable, not re-minted.
    registry.gateway.routeDaemonFrame('m1', {
      type: 'conversationsChanged',
      conversations: [conv('parent-1')],
      diagnostics: [],
    })
    const again = registry.modules.memory
      .allConversations()
      .find((conversation) => conversation.id === 'parent-1')
    expect(again?.podiumId).toBe(parent?.podiumId)
  })

  it('transcriptRead carries the recorded segment path as pathHint', () => {
    const registry = makeRegistry()
    const daemon: unknown[] = []
    registry.gateway.attachDaemon('local', (m) => daemon.push(m))
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/moved/to',
    })
    registry.gateway.routeDaemonFrame('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-x' },
    })
    // A discovery scan recorded where the file actually lives (original bucket).
    registry.gateway.routeDaemonFrame('local', {
      type: 'conversationsChanged',
      conversations: [
        conv('native-x', { path: '/home/u/.claude/projects/-original-spot/native-x.jsonl' }),
      ],
      diagnostics: [],
    })
    void registry.modules.rpc.readTranscript(
      { sessionId, direction: 'before', limit: 10 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
    const read = daemon.find((m) => (m as { type: string }).type === 'transcriptRead') as {
      pathHint?: string
      cwd: string
    }
    expect(read.cwd).toBe('/moved/to') // restamped cwd still sent (fallback input)
    expect(read.pathHint).toBe('/home/u/.claude/projects/-original-spot/native-x.jsonl')
  })

  it('sessionResumeRef stamps the session and a roll keeps the same identity', () => {
    const registry = makeRegistry()
    registry.gateway.attachDaemon('local', () => {})
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })

    registry.gateway.routeDaemonFrame('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-first' },
    })
    const meta1 = registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    const podiumId = meta1?.conversationPodiumId
    expect(podiumId).toMatch(/^conv_/)

    // The harness rolls into a fresh file (resume): new native id, SAME identity.
    registry.gateway.routeDaemonFrame('local', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-rolled' },
    })
    const meta2 = registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(meta2?.conversationPodiumId).toBe(podiumId)
    expect(meta2?.resume?.value).toBe('native-rolled')
  })
})
