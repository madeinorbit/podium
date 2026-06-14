import { describe, expect, it } from 'vitest'
import { normalizeSettings } from './settings'

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
