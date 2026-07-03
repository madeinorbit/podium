import { describe, expect, it } from 'vitest'
import {
  AUTO,
  agentSupportsEffort,
  effortLabel,
  effortOptions,
  isEffortValid,
  modelLabel,
  modelOptions,
} from './agent-models'

describe('agent-models catalog', () => {
  it('lists Auto first for every agent (model + effort)', () => {
    for (const kind of ['claude-code', 'codex', 'grok', 'opencode', 'cursor'] as const) {
      expect(modelOptions(kind)[0]).toEqual({ value: AUTO, label: 'Auto' })
      expect(effortOptions(kind)[0]).toEqual({ value: AUTO, label: 'Auto' })
    }
  })

  it('exposes real per-agent models beyond auto', () => {
    expect(modelOptions('claude-code').map((o) => o.value)).toContain('opus')
    expect(modelOptions('grok').map((o) => o.value)).toContain('grok-build')
  })

  it('scopes effort ladders per agent', () => {
    expect(effortOptions('claude-code').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    // Codex effort (verified via `codex debug models`): low → xhigh, no minimal.
    expect(effortOptions('codex').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    // opencode --variant: minimal → max.
    expect(effortOptions('opencode').map((o) => o.value)).toEqual([
      'auto',
      'minimal',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  it('cursor has no effort flag', () => {
    expect(agentSupportsEffort('cursor')).toBe(false)
    expect(agentSupportsEffort('claude-code')).toBe(true)
    // Only the auto sentinel is offered.
    expect(effortOptions('cursor')).toEqual([{ value: AUTO, label: 'Auto' }])
  })

  it('labels known values, falls back to raw for custom, Auto for the sentinel', () => {
    expect(modelLabel('claude-code', 'opus')).toBe('Opus')
    expect(modelLabel('claude-code', 'auto')).toBe('Auto')
    expect(modelLabel('claude-code', '')).toBe('Auto')
    expect(modelLabel('claude-code', 'some/custom-model')).toBe('some/custom-model')
    expect(effortLabel('claude-code', 'xhigh')).toBe('Extra high')
  })

  it('isEffortValid rejects an out-of-ladder value (codex tops at xhigh, no max)', () => {
    expect(isEffortValid('claude-code', 'max')).toBe(true)
    expect(isEffortValid('codex', 'xhigh')).toBe(true)
    expect(isEffortValid('codex', 'max')).toBe(false)
    expect(isEffortValid('codex', 'auto')).toBe(true)
  })
})
