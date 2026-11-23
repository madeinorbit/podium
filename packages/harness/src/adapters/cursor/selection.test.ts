import { describe, expect, it, vi } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import { parseCursorModels } from './model-probe.js'
import { cursorEffortVariant, cursorSelectedModel } from './model-variants.js'
import { resolveCursorSelection } from './selection.js'

const output = `auto - Auto
claude-opus-thinking-low - Opus Low
claude-opus-thinking-high - Opus High
claude-opus-thinking-low-fast - Opus Low Fast
claude-opus-thinking-high-fast - Opus High Fast
gpt-codex-max - Codex Max
composer - Composer`

describe('Cursor native effort variants', () => {
  it('offers only reported sibling levels and preserves the other model options', () => {
    const models = parseCursorModels(output)
    expect(models[0]?.efforts).toEqual(['low', 'high'])
    expect(models[4]?.efforts).toBeUndefined()
    expect(cursorEffortVariant(models, 'claude-opus-thinking-low-fast', 'high')).toBe(
      'claude-opus-thinking-high-fast',
    )
    expect(cursorEffortVariant(models, 'claude-opus-thinking-low', 'medium')).toBeUndefined()
    expect(cursorEffortVariant(models, 'gpt-codex-max', 'max')).toBeUndefined()
    expect(cursorSelectedModel('claude-opus-thinking-high', 'high')).toBe(
      'claude-opus-thinking-high',
    )
    expect(cursorSelectedModel('claude-opus-thinking-low', 'high')).toBe(
      'claude-opus-thinking-high',
    )
    expect(cursorSelectedModel('claude-opus-thinking-low-fast', 'high')).toBe(
      'claude-opus-thinking-high-fast',
    )
    expect(() => cursorSelectedModel('composer', 'high')).toThrow('native model variant')
  })

  it('resolves effort-only configuration with the pinned account catalog', async () => {
    const ctx = testHarnessContext({ kind: 'cursor' })
    const probe = vi.fn(async () => parseCursorModels(output))
    const input = {
      model: 'claude-opus-thinking-low',
      effort: 'high',
      cwd: '/project',
      installation: ctx.installation,
      env: ctx.env,
    }
    expect(await resolveCursorSelection(input, probe)).toEqual({
      model: 'claude-opus-thinking-high',
      effort: 'high',
    })
    expect(probe).toHaveBeenCalledWith('cursor', {
      contexts: { cursor: { installation: ctx.installation, env: ctx.env } },
    })
    expect(
      await resolveCursorSelection({ ...input, model: 'claude-opus-thinking-high' }, probe),
    ).toEqual({ model: 'claude-opus-thinking-high', effort: 'high' })
    expect(probe).toHaveBeenCalledTimes(1)
    await expect(resolveCursorSelection({ ...input, effort: 'medium' }, probe)).rejects.toThrow(
      'did not report',
    )
    expect(
      await resolveCursorSelection({ ...input, model: 'auto', effort: 'auto' }, probe),
    ).toEqual({ model: 'auto', effort: 'auto' })
  })
})
