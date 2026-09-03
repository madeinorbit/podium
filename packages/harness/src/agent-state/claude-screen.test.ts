import { describe, expect, it } from 'vitest'
import {
  CLAUDE_AUTO_MODE_PROMPT,
  CLAUDE_TRANSCRIPT_DISABLED,
  classifyClaudeScreen,
} from './claude-screen.js'

describe('Claude terminal screen classifier', () => {
  it('materializes the auto-mode onboarding prompt as an answerable question', () => {
    const observation = classifyClaudeScreen([
      'Claude Code',
      CLAUDE_AUTO_MODE_PROMPT,
      'Set it up',
      "Don't show again",
    ])

    expect(observation.interactionVisible).toBe(true)
    expect(observation.events).toHaveLength(1)
    expect(observation.events[0]).toMatchObject({
      kind: 'needs_user',
      need: 'question',
      summary: CLAUDE_AUTO_MODE_PROMPT,
      source: 'classifier',
      confidence: 0.3,
      interview: {
        questions: [
          {
            question: CLAUDE_AUTO_MODE_PROMPT,
            options: [{ label: 'Set it up' }, { label: "Don't show again" }],
          },
        ],
      },
    })
  })

  it('requires an action label so ordinary Claude copy does not become a blocker', () => {
    const observation = classifyClaudeScreen([CLAUDE_AUTO_MODE_PROMPT])

    expect(observation.interactionVisible).toBe(false)
    expect(observation.events).toEqual([])
  })

  it('recognizes the native login-success signal without inspecting credentials', () => {
    for (const signal of ['Login successful', 'Authentication successful']) {
      const observation = classifyClaudeScreen([signal])

      expect(observation.auth).toBe('logged-in')
      expect(observation.events).toEqual([])
    }

    expect(classifyClaudeScreen(['Claude said: Login successful']).auth).toBeUndefined()
  })

  it('declares an observation gap when Claude disables transcript saving', () => {
    const observation = classifyClaudeScreen([
      'WARNING ' + CLAUDE_TRANSCRIPT_DISABLED + ' - inherited CLAUDE_CODE_CHILD_SESSION marker',
      'Cerebrating…',
    ])

    expect(observation.events).toEqual([
      {
        kind: 'observation_gap',
        reason: 'transcript_disabled',
        source: 'classifier',
        confidence: 0.3,
      },
    ])
  })
})
