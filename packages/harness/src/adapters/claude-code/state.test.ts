import { describe, expect, it } from 'vitest'
import {
  CLAUDE_AUTO_MODE_PROMPT,
  CLAUDE_FOLDER_TRUST_SUMMARY,
  CLAUDE_TRANSCRIPT_DISABLED,
  classifyClaudeScreen,
} from './state.js'

/** Claude Code 2.1.280's first-run folder-trust dialog, as the daemon's VT
 *  buffer renders it at 120 columns (captured from the real CLI, POD-4632). */
const FOLDER_TRUST_SCREEN = [
  '────────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  ' /home/user/sbx/repos/demo',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
]

/** The older numbered variant of the same dialog. */
const FOLDER_TRUST_SCREEN_NUMBERED = [
  ' Do you trust the files in this folder?',
  ' /home/user/sbx/repos/demo',
  ' Claude Code may read files in this folder. Reading untrusted files may lead Claude Code to behave in unexpected ways.',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
  ' Enter to confirm · Esc to exit',
]

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

  describe('the first-run folder-trust dialog (POD-4632)', () => {
    for (const [label, screen] of [
      ['the current dialog', FOLDER_TRUST_SCREEN],
      ['the older numbered dialog', FOLDER_TRUST_SCREEN_NUMBERED],
    ] as const) {
      it(`reports ${label} as a blocking question, never as ready`, () => {
        const observation = classifyClaudeScreen(screen)

        expect(observation.interactionVisible).toBe(true)
        expect(observation.events).toEqual([
          {
            kind: 'needs_user',
            need: 'question',
            summary: CLAUDE_FOLDER_TRUST_SUMMARY,
            source: 'classifier',
            confidence: 0.3,
          },
        ])
      })
    }

    it('carries no options, so nothing can be typed at a menu digits do not move', () => {
      // Claude 2.1.280 draws this menu unnumbered and ignores a digit key: an
      // option list here would become Chat buttons that type a digit and do
      // nothing. Trust is the user's security decision; it is answered in the
      // terminal and never by Podium.
      const [event] = classifyClaudeScreen(FOLDER_TRUST_SCREEN).events
      expect(event).not.toHaveProperty('interview')
    })

    it('needs both the question and an answer row on screen', () => {
      const titleOnly = classifyClaudeScreen(FOLDER_TRUST_SCREEN.slice(0, 7))
      expect(titleOnly.interactionVisible).toBe(false)
      expect(titleOnly.events).toEqual([])

      const quoted = classifyClaudeScreen([
        '⏺ The dialog says "Yes, I trust this folder" and "No, exit".',
      ])
      expect(quoted.interactionVisible).toBe(false)
      expect(quoted.events).toEqual([])
    })
  })
})
