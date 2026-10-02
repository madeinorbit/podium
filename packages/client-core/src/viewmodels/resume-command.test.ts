import { describe, expect, it } from 'vitest'
import type { SessionView } from '../session-values'
import { resumeCommand } from './index'

describe('resumeCommand', () => {
  it('separates the Claude executable from the resume flag', () => {
    const session = {
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: 'conversation-id' },
    } as SessionView

    expect(resumeCommand(session)).toBe('claude --resume conversation-id')
  })
})
