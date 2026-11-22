import { describe, expect, it, vi } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import { resolvePiSelection } from './selection.js'

describe('Pi Auto selections on a resumed conversation', () => {
  const context = testHarnessContext({ kind: 'pi' })
  const input = { installation: context.installation, cwd: '/project', env: {} }
  it('resolves defaults through a fresh state query while preserving explicit fields', async () => {
    const read = vi.fn(async () => ({
      model: { provider: 'test', id: 'default' },
      thinkingLevel: 'medium',
    }))
    await expect(
      resolvePiSelection({ ...input, model: 'auto', effort: 'auto' }, read),
    ).resolves.toEqual({ model: 'test/default', effort: 'medium' })
    await expect(
      resolvePiSelection({ ...input, model: 'test/other', effort: 'auto' }, read),
    ).resolves.toEqual({ model: 'test/other', effort: 'medium' })
    await expect(
      resolvePiSelection({ ...input, model: 'auto', effort: 'high' }, read),
    ).resolves.toEqual({ model: 'test/default', effort: 'high' })
    expect(read).toHaveBeenCalledTimes(3)
    await expect(
      resolvePiSelection({ ...input, model: 'test/other', effort: 'high' }, read),
    ).resolves.toEqual({ model: 'test/other', effort: 'high' })
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('refuses to report Auto as applied when Pi cannot resolve the default', async () => {
    await expect(resolvePiSelection({ ...input, model: 'auto' }, async () => ({}))).rejects.toThrow(
      'default model',
    )
  })
})
