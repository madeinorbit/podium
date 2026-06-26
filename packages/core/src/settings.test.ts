import { describe, expect, it } from 'vitest'
import {
  AgentChoice,
  AUTO_CONTINUE_BASE_DELAY_MS,
  AUTO_CONTINUE_MAX_DELAY_MS,
  HarnessAgent,
  normalizeSettings,
  shouldPromptAutoContinue,
} from './settings'

describe('settings harness choices', () => {
  it('accepts Grok and OpenCode as session defaults and harness backends', () => {
    expect(AgentChoice.parse('grok')).toBe('grok')
    expect(AgentChoice.parse('opencode')).toBe('opencode')
    expect(HarnessAgent.parse('grok')).toBe('grok')
    expect(HarnessAgent.parse('opencode')).toBe('opencode')

    const s = normalizeSettings({
      sessionDefaults: { agent: 'grok' },
      superagent: { kind: 'harness', harnessAgent: 'grok' },
    })

    expect(s.sessionDefaults.agent).toBe('grok')
    expect(s.superagent).toMatchObject({ kind: 'harness', harnessAgent: 'grok' })
  })
})

describe('normalizeSettings — sessionDefaults.startScreen', () => {
  it('defaults startScreen to native', () => {
    expect(normalizeSettings({}).sessionDefaults.startScreen).toBe('native')
  })

  it('accepts all three enum values', () => {
    expect(normalizeSettings({ sessionDefaults: { startScreen: 'chat' } }).sessionDefaults.startScreen).toBe('chat')
    expect(normalizeSettings({ sessionDefaults: { startScreen: 'auto' } }).sessionDefaults.startScreen).toBe('auto')
    expect(normalizeSettings({ sessionDefaults: { startScreen: 'native' } }).sessionDefaults.startScreen).toBe('native')
  })

  it('fills in startScreen default for old blobs without it', () => {
    const s = normalizeSettings({ sessionDefaults: { agent: 'grok' } })
    expect(s.sessionDefaults.startScreen).toBe('native')
  })
})

describe('normalizeSettings — sidebar defaults', () => {
  it('defaults sidebar sort to lastUsed with empty custom order', () => {
    const s = normalizeSettings({})
    expect(s.sidebar.repoSort).toBe('lastUsed')
    expect(s.sidebar.repoOrder).toEqual([])
  })

  it('fills in sidebar defaults for old blobs without sidebar key', () => {
    const s = normalizeSettings({
      sessionDefaults: { agent: 'auto' },
      superagent: { kind: 'api', provider: 'anthropic' },
    })
    expect(s.sidebar.repoSort).toBe('lastUsed')
    expect(s.sidebar.repoOrder).toEqual([])
  })
})

describe('normalizeSettings — Codex harness migration', () => {
  it('folds a saved Codex harness superagent onto the API Codex provider', () => {
    const s = normalizeSettings({
      superagent: { kind: 'harness', harnessAgent: 'codex', harnessModel: 'auto' },
    })
    expect(s.superagent.kind).toBe('api')
    expect(s.superagent.provider).toBe('codex')
    expect(s.superagent.model).toBe('gpt-5.5')
  })

  it('keeps an explicit harness model when migrating', () => {
    const s = normalizeSettings({
      superagent: { kind: 'harness', harnessAgent: 'codex', harnessModel: 'gpt-5.4' },
    })
    expect(s.superagent.provider).toBe('codex')
    expect(s.superagent.model).toBe('gpt-5.4')
  })

  it('also migrates the work LLM backend', () => {
    const s = normalizeSettings({
      workLlm: { kind: 'harness', harnessAgent: 'codex' },
    })
    expect(s.workLlm.kind).toBe('api')
    expect(s.workLlm.provider).toBe('codex')
  })

  it('leaves the Claude Code harness untouched', () => {
    const s = normalizeSettings({
      superagent: { kind: 'harness', harnessAgent: 'claude-code' },
    })
    expect(s.superagent.kind).toBe('harness')
    expect(s.superagent.harnessAgent).toBe('claude-code')
  })

  it('leaves an API backend untouched', () => {
    const s = normalizeSettings({
      superagent: { kind: 'api', provider: 'anthropic', model: 'claude-x' },
    })
    expect(s.superagent).toMatchObject({ kind: 'api', provider: 'anthropic', model: 'claude-x' })
  })
})

describe('normalizeSettings — notification targets', () => {
  it('fills Telegram notification defaults for old saved settings', () => {
    const s = normalizeSettings({
      notifications: { web: false, ntfyTopic: 'podium-topic' },
    })

    expect(s.notifications).toMatchObject({
      web: false,
      ntfyTopic: 'podium-topic',
      telegramBotToken: '',
      telegramChatId: '',
    })
  })

  it('keeps explicit Telegram notification settings', () => {
    const s = normalizeSettings({
      notifications: {
        web: true,
        ntfyTopic: '',
        telegramBotToken: '123456:secret',
        telegramChatId: '-1001234567890',
      },
    })

    expect(s.notifications.telegramBotToken).toBe('123456:secret')
    expect(s.notifications.telegramChatId).toBe('-1001234567890')
  })
})

describe('normalizeSettings — autoContinue', () => {
  it('defaults autoContinue to disabled and not-yet-prompted', () => {
    expect(normalizeSettings({}).autoContinue).toEqual({ enabled: false, promptDismissed: false })
  })

  it('fills autoContinue defaults for old blobs without the key', () => {
    const s = normalizeSettings({ sessionDefaults: { agent: 'grok' } })
    expect(s.autoContinue).toEqual({ enabled: false, promptDismissed: false })
  })

  it('keeps explicit autoContinue values', () => {
    const s = normalizeSettings({ autoContinue: { enabled: true, promptDismissed: true } })
    expect(s.autoContinue).toEqual({ enabled: true, promptDismissed: true })
  })
})

describe('auto-continue backoff constants', () => {
  it('escalates from 10s and caps at 5 minutes', () => {
    expect(AUTO_CONTINUE_BASE_DELAY_MS).toBe(10_000)
    expect(AUTO_CONTINUE_MAX_DELAY_MS).toBe(300_000)
  })
})

describe('shouldPromptAutoContinue', () => {
  it('prompts only when disabled and not previously dismissed', () => {
    expect(shouldPromptAutoContinue(normalizeSettings({}))).toBe(true)
    expect(
      shouldPromptAutoContinue(
        normalizeSettings({ autoContinue: { enabled: true, promptDismissed: false } }),
      ),
    ).toBe(false)
    expect(
      shouldPromptAutoContinue(
        normalizeSettings({ autoContinue: { enabled: false, promptDismissed: true } }),
      ),
    ).toBe(false)
  })
})
