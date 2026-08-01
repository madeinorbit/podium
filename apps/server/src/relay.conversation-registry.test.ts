import type { ConversationSummaryWire, ConversationSummaryWireInput } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

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
    const inbox: ServerMessage[] = []
    registry.clientGateway.attachClient((m) => inbox.push(m))
    registry.gateway.routeDaemonFrame('m1', {
      type: 'conversationsChanged',
      conversations: [conv('parent-1'), conv('sub-1', { parentConversationId: 'parent-1' })],
      diagnostics: [],
    })
    // Serving is coalesced onto the microtask boundary (POD-1203); this is the
    // deterministic seam. Without it the last `conversationsChanged` in the inbox
    // is still the one the ATTACH produced, before the scan committed anything.
    registry.modules.funnel.flushDeltas()
    const msg = inbox.filter((m) => m.type === 'conversationsChanged').at(-1)
    if (msg?.type !== 'conversationsChanged') throw new Error('no conversationsChanged')
    const byId = new Map(msg.conversations.map((c) => [c.id, c]))
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
    const again = inbox.filter((m) => m.type === 'conversationsChanged').at(-1)
    if (again?.type !== 'conversationsChanged') throw new Error('no rebroadcast')
    expect(again.conversations[0]?.podiumId).toBe(parent?.podiumId)
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
      { kind: 'user', id: 'conversation-reader' },
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
