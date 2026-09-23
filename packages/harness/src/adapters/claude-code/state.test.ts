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

/**
 * Claude Code 2.1.280's own "a turn is running" marks, as the daemon's VT buffer
 * renders them (captured from the real CLI at 120 columns, POD-4633). A user
 * interrupt fires no hook, so the screen is one of the two places it shows.
 */
describe('Claude turn-running screen rule [POD-4633]', () => {
  const RULE = '─'.repeat(120)
  const HEADER = [' ▐▛███▛█   Claude Code v2.1.280', '▝▜██████▀  Haiku 4.5 · Claude Max']
  const PROMPT = '❯ Write the numbers from 1 to 2000, one per line, no commentary.'

  const THINKING = [
    ...HEADER,
    PROMPT,
    '✢ Pontificating… (2s · thinking)',
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · esc to interrupt · ← 3 agents',
  ]
  // A draft in the input box drops the footer hint; the spinner stays.
  const THINKING_WITH_DRAFT = [
    ...HEADER,
    PROMPT,
    '✽ Precipitating… (3s · thinking)',
    RULE,
    '❯ typed while busy',
    RULE,
    '  ⏸ manual mode on',
  ]
  // Streaming text: no spinner row, the footer hint says it.
  const STREAMING = [...HEADER, PROMPT, '● 1', '  2', '  3', RULE, '❯ ', RULE, '  ⏸ manual mode on · esc to interrupt · ← 3 agents']
  // Esc after output: Claude prints the interrupt row and goes back to its prompt.
  const INTERRUPTED = [
    ...HEADER,
    PROMPT,
    '● 1',
    '  2',
    '  ⎿  Interrupted · What should Claude do instead?',
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · ? for shortcuts · ← 3 agents',
  ]
  // Esc before any output: the turn is taken back and the prompt returns to the box.
  const REWOUND = [...HEADER, RULE, PROMPT, RULE, '  ⏸ manual mode on']
  const FINISHED = [
    ...HEADER,
    '❯ Say only the word hi.',
    '● hi',
    '✻ Churned for 3s · done 12:08 PM',
    RULE,
    '❯ ',
    RULE,
    '  ⏸ manual mode on · ? for shortcuts · ← 3 agents',
  ]

  it('reads a running turn from the spinner row or the footer hint', () => {
    expect(classifyClaudeScreen(THINKING).turnRunning).toBe(true)
    expect(classifyClaudeScreen(THINKING_WITH_DRAFT).turnRunning).toBe(true)
    expect(classifyClaudeScreen(STREAMING).turnRunning).toBe(true)
  })

  it('reads no running turn once Claude is back at its prompt', () => {
    expect(classifyClaudeScreen(INTERRUPTED).turnRunning).toBe(false)
    expect(classifyClaudeScreen(REWOUND).turnRunning).toBe(false)
    expect(classifyClaudeScreen(FINISHED).turnRunning).toBe(false)
  })

  /**
   * What sits in the input box (POD-4651). An early Stop leaves the prompt there
   * (measured on 2.1.280: Esc 0.3 s and 2.5 s after submit), and whatever Podium
   * types next lands after it: "…Do not use tools.What is 3 times 3?".
   */
  it('reads the input box, one line per screen row, empty once cleared', () => {
    expect(classifyClaudeScreen(REWOUND).inputDraft).toBe(
      'Write the numbers from 1 to 2000, one per line, no commentary.',
    )
    expect(classifyClaudeScreen(THINKING_WITH_DRAFT).inputDraft).toBe('typed while busy')
    expect(classifyClaudeScreen(THINKING).inputDraft).toBe('')
    expect(classifyClaudeScreen(INTERRUPTED).inputDraft).toBe('')
    expect(classifyClaudeScreen(FINISHED).inputDraft).toBe('')
    // A prompt wrapped over two rows, the second indented under the first.
    const wrapped = [
      ...HEADER,
      RULE,
      '❯ Think carefully, then write the numbers from 1 to 300, each on its own line with one short sentence about it. Do not',
      '  use tools.',
      RULE,
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ]
    expect(classifyClaudeScreen(wrapped).inputDraft).toBe(
      'Think carefully, then write the numbers from 1 to 300, each on its own line with one short sentence about it. Do not\nuse tools.',
    )
  })

  it('reads no input box where none is drawn', () => {
    // Claude's Rewind menu replaces the box; a menu is not a draft.
    const rewindMenu = [...HEADER, '▔'.repeat(120), '   Rewind', '   Nothing to rewind to yet.', '   Esc to cancel']
    expect(classifyClaudeScreen(rewindMenu).inputDraft).toBeUndefined()
    // Between two rules, but not Claude's prompt row.
    expect(classifyClaudeScreen([...HEADER, RULE, ' Accessing workspace:', RULE]).inputDraft).toBeUndefined()
  })
})
