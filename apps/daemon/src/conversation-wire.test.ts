import type { AgentConversationSummary } from '@podium/agent-bridge'
import { ConversationSummaryWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { summaryToWire } from './conversation-wire'

// Discovery summary → wire shape. The load-bearing detail here is the transcript
// mirror's dirty signal: `sizeBytes` must survive the hop (and stay parseable),
// or the server falls back to NULL-reported rows and per-segment eof-check sweeps.

const summary = (extra: Partial<AgentConversationSummary> = {}): AgentConversationSummary => ({
  id: 'native-1',
  agentKind: 'claude-code',
  title: 'a talk',
  source: {
    providerId: 'claude-code-jsonl',
    root: '/home/u/.claude',
    path: '/home/u/.claude/projects/-p/native-1.jsonl',
  },
  ...extra,
})

describe('summaryToWire', () => {
  it('carries sizeBytes onto the wire and it parses as ConversationSummaryWire', () => {
    const wire = summaryToWire(summary({ sizeBytes: 12345 }))
    expect(wire.sizeBytes).toBe(12345)
    expect(wire.path).toBe('/home/u/.claude/projects/-p/native-1.jsonl')
    expect(ConversationSummaryWire.parse(wire)).toEqual(wire)
  })

  it('omits sizeBytes when discovery did not report one (size-less providers)', () => {
    const wire = summaryToWire(summary())
    expect('sizeBytes' in wire).toBe(false)
    expect(ConversationSummaryWire.parse(wire)).toEqual(wire)
  })
})
