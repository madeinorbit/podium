import { describe, expect, it } from 'vitest'
import {
  AgentChoice,
  AUTO_CONTINUE_BASE_DELAY_MS,
  AUTO_CONTINUE_MAX_DELAY_MS,
  HARNESS_MCP_SUPPORT,
  HarnessAgent,
  managedAccountId,
  nativeAccountId,
  normalizeSettings,
  resolveRole,
  roleApiBackend,
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

    expect(s.roles.coding.accountId).toBe(nativeAccountId('grok'))
    expect(resolveRole(s, 'coding')).toMatchObject({ execution: 'harness', harness: 'grok' })
    expect(resolveRole(s, 'superagent')).toMatchObject({ execution: 'harness', harness: 'grok' })
  })
})

describe('normalizeSettings — coding.startScreen', () => {
  it('defaults startScreen to native', () => {
    expect(normalizeSettings({}).roles.coding.startScreen).toBe('native')
  })

  it('carries startScreen through migration', () => {
    expect(
      normalizeSettings({ sessionDefaults: { startScreen: 'chat' } }).roles.coding.startScreen,
    ).toBe('chat')
    expect(
      normalizeSettings({ sessionDefaults: { startScreen: 'auto' } }).roles.coding.startScreen,
    ).toBe('auto')
  })

  it('fills in startScreen default for old blobs without it', () => {
    const s = normalizeSettings({ sessionDefaults: { agent: 'grok' } })
    expect(s.roles.coding.startScreen).toBe('native')
  })
})

describe('normalizeSettings — legacy → roles migration', () => {
  it('migrates the real live blob shape (superagent+workLlm on codex api, coding claude-code)', () => {
    const s = normalizeSettings({
      sessionDefaults: {
        agent: 'claude-code',
        model: 'auto',
        subagentModel: 'auto',
        effort: 'auto',
        startScreen: 'native',
      },
      superagent: { kind: 'api', provider: 'codex', model: 'gpt-5.5' },
      workLlm: { kind: 'api', provider: 'codex', model: 'gpt-5.4-mini' },
    })
    expect(s.roles.coding).toMatchObject({
      accountId: nativeAccountId('claude-code'),
      model: 'auto',
    })
    // codex api → native:codex account; one-shot/orchestrator roles run it as the Responses API.
    expect(s.roles.superagent).toMatchObject({
      accountId: nativeAccountId('codex'),
      model: 'gpt-5.5',
    })
    expect(s.roles.background).toMatchObject({
      accountId: nativeAccountId('codex'),
      model: 'gpt-5.4-mini',
    })
    expect(resolveRole(s, 'superagent')).toMatchObject({
      execution: 'api',
      provider: 'codex',
      model: 'gpt-5.5',
    })
    expect(resolveRole(s, 'background')).toMatchObject({
      execution: 'api',
      provider: 'codex',
      model: 'gpt-5.4-mini',
    })
    // coding subagentStrategy back-filled (older blob predates it).
    expect(s.roles.coding.subagentStrategy).toBe('builtin')
  })

  it('is idempotent — a blob already on `roles` is left as-is', () => {
    const once = normalizeSettings({ superagent: { kind: 'harness', harnessAgent: 'grok' } })
    const twice = normalizeSettings(once)
    expect(twice.roles).toEqual(once.roles)
  })

  it('maps a managed api-key provider to a managed account', () => {
    const s = normalizeSettings({
      workLlm: { kind: 'api', provider: 'anthropic', model: 'claude-x' },
    })
    expect(s.roles.background.accountId).toBe(managedAccountId('anthropic'))
    expect(resolveRole(s, 'background')).toMatchObject({ execution: 'api', provider: 'anthropic' })
  })

  it('roleApiBackend reconstructs an api LlmBackend for the llmClient path', () => {
    const s = normalizeSettings({
      workLlm: { kind: 'api', provider: 'anthropic', model: 'claude-x', harnessEffort: 'high' },
    })
    expect(roleApiBackend(s, 'background')).toMatchObject({
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-x',
      harnessEffort: 'high',
    })
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

describe('normalizeSettings — Codex harness migration into roles', () => {
  it('keeps a saved Codex harness superagent as a native codex account (MCP, issue #84)', () => {
    const s = normalizeSettings({
      superagent: { kind: 'harness', harnessAgent: 'codex', harnessModel: 'auto' },
    })
    expect(s.roles.superagent.accountId).toBe(nativeAccountId('codex'))
    // A codex HARNESS superagent runs codex (not the Responses API fallback).
    expect(superagentHarnessAgent(s)).toBe('codex')
  })

  it('migrates a codex-harness work LLM to the codex api account (chat-only consumer)', () => {
    const s = normalizeSettings({ workLlm: { kind: 'harness', harnessAgent: 'codex' } })
    expect(s.roles.background.accountId).toBe(nativeAccountId('codex'))
    expect(s.roles.background.model).toBe('gpt-5.5')
    expect(resolveRole(s, 'background')).toMatchObject({ execution: 'api', provider: 'codex' })
  })

  it('keeps an explicit work LLM harness model when migrating', () => {
    const s = normalizeSettings({
      workLlm: { kind: 'harness', harnessAgent: 'codex', harnessModel: 'gpt-5.4' },
    })
    expect(s.roles.background.model).toBe('gpt-5.4')
  })

  it('maps a Claude Code harness superagent to the native claude-code account', () => {
    const s = normalizeSettings({ superagent: { kind: 'harness', harnessAgent: 'claude-code' } })
    expect(s.roles.superagent.accountId).toBe(nativeAccountId('claude-code'))
    expect(resolveRole(s, 'superagent')).toMatchObject({
      execution: 'harness',
      harness: 'claude-code',
    })
  })

  it('maps an anthropic api backend to a managed account', () => {
    const s = normalizeSettings({
      superagent: { kind: 'api', provider: 'anthropic', model: 'claude-x' },
    })
    expect(s.roles.superagent.accountId).toBe(managedAccountId('anthropic'))
    expect(s.roles.superagent.model).toBe('claude-x')
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
    expect(superagentHarnessAgent(normalizeSettings({ sessionDefaults: { agent: 'auto' } }))).toBe(
      'claude-code',
    )
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
