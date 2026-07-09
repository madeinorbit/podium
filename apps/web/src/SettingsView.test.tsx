import { nativeAccountId, normalizeSettings, resolveRole } from '@podium/runtime'
import { describe, expect, it } from 'vitest'

describe('SettingsView background role migration', () => {
  it('migrates a legacy codex-api work LLM onto the background role (Responses API)', () => {
    const s = normalizeSettings({
      workLlm: { kind: 'api', provider: 'codex', model: 'gpt-5.5', harnessAgent: 'codex' },
    })
    expect(s.roles.background.accountId).toBe(nativeAccountId('codex'))
    expect(resolveRole(s, 'background')).toMatchObject({
      execution: 'api',
      provider: 'codex',
      model: 'gpt-5.5',
    })
  })
})
