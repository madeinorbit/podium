import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'

describe('gitWorkflow + issues settings', () => {
  it('defaults are present', () => {
    expect(DEFAULT_SETTINGS.gitWorkflow).toEqual({ defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true })
    expect(DEFAULT_SETTINGS.issues).toEqual({ assistantEnabled: true })
  })
  it('back-compat: an old blob with no gitWorkflow parses with defaults', () => {
    const s = normalizeSettings({ sessionDefaults: { agent: 'claude-code' } })
    expect(s.gitWorkflow.mergeStyle).toBe('ff-only')
    expect(s.issues.assistantEnabled).toBe(true)
  })
})
