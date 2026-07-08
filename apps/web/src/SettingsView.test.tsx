import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { backendWithRunKind } from './SettingsView'

describe('SettingsView Background LLM run target', () => {
  it('drops a stale Codex harness agent when switching a migrated backend to harness', () => {
    const backend = normalizeSettings({
      workLlm: {
        kind: 'api',
        provider: 'codex',
        model: 'gpt-5.5',
        harnessAgent: 'codex',
      },
    }).workLlm

    const next = backendWithRunKind(backend, 'harness')

    expect(next).toMatchObject({
      kind: 'harness',
      harnessAgent: 'claude-code',
    })
    expect(normalizeSettings({ workLlm: next }).workLlm.kind).toBe('harness')
  })
})
