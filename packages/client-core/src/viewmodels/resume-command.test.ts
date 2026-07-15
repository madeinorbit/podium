import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { resumeCommand } from './derive'

describe('resumeCommand', () => {
  it('separates the Claude executable from the resume flag', () => {
    const session = {
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: 'conversation-id' },
    } as SessionMeta

    expect(resumeCommand(session)).toBe('claude --resume conversation-id')
  })
})
