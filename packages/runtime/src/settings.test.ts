import { describe, expect, it } from 'vitest'
import {
  AgentChoice,
  AUTO_CONTINUE_BASE_DELAY_MS,
  AUTO_CONTINUE_MAX_DELAY_MS,
  HARNESS_MCP_SUPPORT,
  HarnessAgent,
  normalizeSettings,
  shouldPromptAutoContinue,
  superagentHarnessAgent,
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
    expect(s.sidebar.groupByRepo).toBe(false)
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
  it('keeps a saved Codex harness superagent (codex mounts MCP now, issue #84)', () => {
    const s = normalizeSettings({
      superagent: { kind: 'harness', harnessAgent: 'codex', harnessModel: 'auto' },
    })
    expect(s.superagent.kind).toBe('harness')
    expect(s.superagent.harnessAgent).toBe('codex')
  })

  it('still migrates the work LLM codex harness (chat-only consumer)', () => {
    const s = normalizeSettings({
      workLlm: { kind: 'harness', harnessAgent: 'codex' },
    })
    expect(s.workLlm.kind).toBe('api')
    expect(s.workLlm.provider).toBe('codex')
    expect(s.workLlm.model).toBe('gpt-5.5')
  })

  it('keeps an explicit work LLM harness model when migrating', () => {
    const s = normalizeSettings({
      workLlm: { kind: 'harness', harnessAgent: 'codex', harnessModel: 'gpt-5.4' },
    })
    expect(s.workLlm.provider).toBe('codex')
    expect(s.workLlm.model).toBe('gpt-5.4')
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

describe('superagentHarnessAgent (issue #84)', () => {
  it('follows an explicit harness choice', () => {
    const s = normalizeSettings({ superagent: { kind: 'harness', harnessAgent: 'codex' } })
    expect(superagentHarnessAgent(s)).toBe('codex')
  })
  it('falls back to sessionDefaults.agent for api-kind settings', () => {
    const s = normalizeSettings({
      superagent: { kind: 'api', provider: 'openrouter' },
      sessionDefaults: { agent: 'grok' },
    })
    expect(superagentHarnessAgent(s)).toBe('grok')
  })
  it("resolves 'auto' (and fresh defaults) to claude-code", () => {
    expect(superagentHarnessAgent(normalizeSettings({}))).toBe('claude-code')
    expect(
      superagentHarnessAgent(normalizeSettings({ sessionDefaults: { agent: 'auto' } })),
    ).toBe('claude-code')
  })
  it('the capability matrix marks claude-code and codex full, the rest none', () => {
    expect(HARNESS_MCP_SUPPORT).toEqual({
      'claude-code': 'full',
      codex: 'full',
      grok: 'none',
      opencode: 'none',
      cursor: 'none',
    })
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
