import { describe, expect, it } from 'vitest'
import { claudeHookAcceptCorrelation } from './accept-correlation.js'

describe("Claude's prompt id on the UserPromptSubmit hook (POD-4841)", () => {
  it('names the prompt_id the hook carries', () => {
    expect(
      claudeHookAcceptCorrelation.harnessRef?.({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'ship it',
        prompt_id: 'prompt-7',
      }),
    ).toEqual([{ kind: 'claude-prompt', id: 'prompt-7' }])
  })

  it('names nothing when the hook carries none, or an empty one', () => {
    for (const payload of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'ship it', prompt_id: '' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'ship it', prompt_id: 7 },
      null,
    ]) {
      expect(claudeHookAcceptCorrelation.harnessRef?.(payload)).toBeUndefined()
    }
  })
})
