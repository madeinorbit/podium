import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CODEX_TRUST_SUMMARY, classifyCodexScreen, codexUsageLimitSummary } from './state.js'
import { codexStateProvider } from './state-provider.js'

/**
 * Real screen captures of codex-cli 0.155.0 (POD-4604 evidence, read from the web
 * terminal at 74 columns). The `# ` lines are the capture's own notes.
 */
function capture(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('# '))
}

const TRUST_SCREEN = capture('trust-prompt.txt')
const USAGE_LIMIT_SCREEN = capture('usage-limit.txt')
const LIMIT_RESET = 'Sep 24th, 2026 8:42 PM'

describe('Codex terminal screen classifier (POD-4650)', () => {
  it('is the screen rule the Codex state provider serves', () => {
    expect(codexStateProvider.screen).toBe(classifyCodexScreen)
  })

  it('reports the directory-trust prompt as a blocking question with no options', () => {
    const observation = classifyCodexScreen(TRUST_SCREEN)

    expect(observation.interactionVisible).toBe(true)
    expect(observation.events).toEqual([
      {
        kind: 'needs_user',
        need: 'question',
        summary: CODEX_TRUST_SUMMARY,
        source: 'classifier',
        confidence: 0.3,
      },
    ])
  })

  it('reports the usage-limit model-switch menu as a blocking question with no options', () => {
    const observation = classifyCodexScreen(USAGE_LIMIT_SCREEN)

    expect(observation.interactionVisible).toBe(true)
    expect(observation.events).toEqual([
      {
        kind: 'needs_user',
        need: 'question',
        summary: codexUsageLimitSummary(LIMIT_RESET),
        source: 'classifier',
        confidence: 0.3,
      },
    ])
    expect(codexUsageLimitSummary(LIMIT_RESET)).toContain(LIMIT_RESET)
  })

  it('still reports the menu when the limit is only near, with no reset time to quote', () => {
    const nearLimit = USAGE_LIMIT_SCREEN.filter(
      (line) => !/hit your usage limit|chatgpt\.com\/codex|again at/.test(line),
    )
    const observation = classifyCodexScreen(nearLimit)

    expect(observation.interactionVisible).toBe(true)
    expect(observation.events).toMatchObject([
      { kind: 'needs_user', need: 'question', summary: codexUsageLimitSummary(undefined) },
    ])
  })

  it('does not hold the session once the menu is closed and only the error stays in the history', () => {
    // After Esc or "Keep current model" Codex is back at its composer; the error
    // line stays in the scrollback for the rest of the session.
    const menuStart = USAGE_LIMIT_SCREEN.findIndex((line) => line.includes('Approaching rate limits'))
    const afterMenu = [...USAGE_LIMIT_SCREEN.slice(0, menuStart), '› ', '  ? for shortcuts']
    const observation = classifyCodexScreen(afterMenu)

    expect(observation).toEqual({ events: [], interactionVisible: false })
  })

  it('does not match a transcript that merely quotes the prompts', () => {
    const quoted = [
      '• Codex asked "Do you trust the contents of this directory?" and I picked 1. Yes, continue',
      '• Then it said: Switch to gpt-5.6-luna for lower credit usage? 2. Keep current model',
    ]
    expect(classifyCodexScreen(quoted)).toEqual({ events: [], interactionVisible: false })
  })

  it('reports nothing for an ordinary Codex screen', () => {
    expect(
      classifyCodexScreen(['› Ask Codex to do anything', '  ? for shortcuts']),
    ).toEqual({ events: [], interactionVisible: false })
  })
})
