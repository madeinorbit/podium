import { describe, expect, it } from 'vitest'
import {
  agentControlHelp,
  postureNotices,
  sessionInterfaceHelp,
  sessionModeHelp,
  sessionModeReadout,
} from './session-posture'

/**
 * WHAT A SESSION SAYS ABOUT ITS LAUNCH TERMS (POD-6858 Task 11,
 * harness-session-posture.md §4.9 and §5).
 *
 * One notice per requirement the launch could not meet, naming the harness
 * and the reason; and the mode shown is the one the harness reports, or the
 * one Podium asked for where the harness reports none.
 */
describe('postureNotices', () => {
  it('turns one unmet requirement into one notice with the exact words', () => {
    const notices = postureNotices({
      agentKind: 'pi',
      launchPosture: {
        requestedMode: null,
        unmet: [
          { requirement: 'autonomy', reason: 'Pi has no approval gate, so it cannot ask first' },
        ],
      },
    })
    expect(notices).toEqual([
      'Pi edits files and runs commands without asking for approval. If you need approval prompts, choose another agent in the new-task box.',
    ])
  })

  it('names each of the five requirements in words', () => {
    const notices = postureNotices({
      agentKind: 'cursor',
      launchPosture: {
        requestedMode: null,
        unmet: [
          { requirement: 'workspace-trust', reason: 'r1' },
          { requirement: 'podium-cli', reason: 'r2' },
          { requirement: 'autonomy', reason: 'r3' },
          { requirement: 'quiet-start', reason: 'r4' },
          { requirement: 'podium-material', reason: 'r5' },
        ],
      },
    })
    expect(notices).toEqual([
      'Cursor may wait for you to trust this folder. Open the terminal and answer its trust question.',
      'Cursor may ask before updating tasks or messaging other agents. Approve Podium commands when prompted to let that work continue.',
      "Cursor's permissions could not be set as requested. Check its own permission controls before continuing.",
      'Cursor may pause at a setup or update screen. Open the terminal and finish that step to continue.',
      'Cursor may ask before opening chat attachments or using connected tools. Approve the request if you want it to use them.',
    ])
  })

  it('says nothing for a session with no report or nothing unmet', () => {
    expect(postureNotices({ agentKind: 'claude-code' })).toEqual([])
    expect(
      postureNotices({
        agentKind: 'claude-code',
        launchPosture: { requestedMode: 'auto', unmet: [] },
      }),
    ).toEqual([])
  })
})

describe('sessionModeReadout', () => {
  it('shows the mode the harness reports over the one Podium asked for', () => {
    expect(
      sessionModeReadout({
        observedMode: 'default',
        launchPosture: { requestedMode: 'auto', unmet: [] },
      }),
    ).toEqual({ mode: 'default', source: 'observed' })
  })

  it('shows the requested mode where the harness reports none', () => {
    expect(sessionModeReadout({ launchPosture: { requestedMode: 'auto', unmet: [] } })).toEqual({
      mode: 'auto',
      source: 'requested',
    })
  })

  it('shows nothing when neither is known', () => {
    expect(sessionModeReadout({})).toBeUndefined()
    expect(
      sessionModeReadout({ launchPosture: { requestedMode: null, unmet: [] } }),
    ).toBeUndefined()
  })
})

describe('permission help', () => {
  it.each([
    ['claude-code', 'default', 'Asks before file edits and commands'],
    ['claude-code', 'manual', 'Asks before file edits and commands'],
    ['claude-code', 'acceptEdits', 'Edits files without asking; commands may still need'],
    ['claude-code', 'auto', 'Reviews tool requests automatically and may refuse'],
    [
      'claude-code',
      'bypassPermissions',
      'Edits files and runs commands without permission prompts',
    ],
    ['claude-code', 'plan', 'Reads and plans without changing your files'],
    ['claude-code', 'dontAsk', 'Refuses actions that need approval instead of asking'],
    ['codex', 'on-request', 'Can edit within its allowed folders; asks you'],
    ['codex', 'auto-review', 'Automatically reviews requests to run beyond its limits'],
    ['codex', 'never', 'Never asks for approval; actions outside its allowed access are refused'],
    ['grok', 'default', 'Asks before file edits and commands'],
    ['grok', 'acceptEdits', 'Edits files without asking; commands may still need'],
    ['grok', 'auto', 'Reviews tool requests automatically and may refuse'],
    ['grok', 'dontAsk', 'Refuses actions that need approval instead of asking'],
    ['grok', 'bypassPermissions', 'Edits files and runs commands without permission prompts'],
    ['grok', 'plan', 'Reads and plans without changing your files'],
    ['opencode', 'ask', 'Asks before file edits and commands'],
    ['opencode', 'auto', 'Runs file edits and commands without asking unless'],
    ['cursor', 'allowlist', 'Asks before actions that are not on your allowed list'],
    ['cursor', 'auto-review', 'Reviews tool requests automatically and may refuse'],
    ['cursor', 'plan', 'Reads and plans without changing your files'],
    ['cursor', 'ask', 'Answers questions without making changes'],
    ['antigravity', 'default', 'Asks before file edits and commands'],
    ['antigravity', 'auto', 'Reviews actions automatically while keeping them within'],
    ['antigravity', 'accept-edits', 'Edits files without asking; commands may still need'],
    ['antigravity', 'always-proceed', 'Edits files and runs commands without permission prompts'],
    ['antigravity', 'plan', 'Reads and plans without changing your files'],
  ])('%s / %s explains its effect and where to change it', (kind, mode, meaning) => {
    const help = sessionModeHelp(kind, { mode, source: 'observed' })
    expect(help).toContain(meaning)
    expect(help).toMatch(/terminal|settings before starting a new session/)
    expect(help).not.toMatch(/posture|provenance|observed|launch|harness|transcript/)
  })

  it('does not present requested permissions as active', () => {
    expect(sessionModeHelp('claude-code', { mode: 'auto', source: 'requested' })).toBe(
      "Requested, not yet confirmed: reviews tool requests automatically and may refuse actions it considers unsafe. Use Shift+Tab in Claude Code's terminal to change permissions.",
    )
  })

  it.each([
    ['new-agent', 'auto'],
    ['codex', 'auto'],
    ['codex', 'toString'],
    ['toString', 'auto'],
  ])('keeps unknown %s / %s permissions unknown', (kind, mode) => {
    expect(sessionModeHelp(kind, { mode, source: 'observed' })).toContain('Podium cannot explain')
  })

  it('keeps the exact agent-specific route to a permission control', () => {
    expect(sessionModeHelp('codex', { mode: 'on-request', source: 'observed' })).toContain(
      "Use /permissions in Codex's terminal",
    )
    expect(sessionModeHelp('opencode', { mode: 'ask', source: 'observed' })).toContain(
      "Change OpenCode's permission settings before starting a new session.",
    )
  })
})

describe('new-session choices', () => {
  it.each([
    ['claude-code', 'Claude Code handles the conversation, file changes and command approvals'],
    ['codex', 'Codex runs the task with file access limited by its permission settings'],
    ['grok', 'Grok handles the conversation, file changes and command approvals'],
    ['opencode', 'OpenCode runs the task with models from the provider you select'],
    ['cursor', 'Cursor runs the task using its own tools and permission rules'],
    ['pi', 'Pi runs the task without asking before file edits or commands'],
    ['antigravity', 'Antigravity runs the task using its own tools and permission rules'],
    ['shell', 'A terminal lets you run commands yourself, without an AI agent'],
    ['future-agent', 'This agent will run the task with its own tools and permission rules'],
  ])('explains %s before it is fixed for the session', (kind, meaning) => {
    expect(agentControlHelp(kind)).toContain(meaning)
    expect(agentControlHelp(kind)).toContain(
      'Choose an agent here before starting; that choice is fixed for the session.',
    )
  })

  it('explains terminal and chat interfaces without implementation terms', () => {
    expect(sessionInterfaceHelp(true)).toContain(
      "You will work in the agent's own terminal interface.",
    )
    expect(sessionInterfaceHelp(false)).toContain(
      "You will work in Podium's chat while the agent runs in the background.",
    )
  })
})
