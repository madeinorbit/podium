import { describe, expect, it, vi } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import { probeAgentModels } from '../../model-probe.js'
import { parseOpencode2Models } from './model-probe-v2.js'

describe('OpenCode preview model catalog', () => {
  it('reads named effort variants from enabled models in the v2 API response', () => {
    expect(
      parseOpencode2Models(
        JSON.stringify({
          data: [
            {
              id: 'sonnet',
              providerID: 'anthropic',
              name: 'Sonnet',
              enabled: true,
              variants: [{ id: 'low' }, { id: 'high' }],
            },
            { id: 'hidden', providerID: 'private', enabled: false, variants: [] },
            { id: 'plain', providerID: 'test', variants: [] },
          ],
        }),
      ),
    ).toEqual([
      { value: 'anthropic/sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
      { value: 'test/plain', label: 'test/plain', efforts: [] },
    ])
  })

  it('uses the preview metadata query instead of the unsupported stable CLI flag', async () => {
    const context = testHarnessContext({ kind: 'opencode', version: '0.0.0-beta-18866' })
    const models = [{ value: 'test/model', label: 'Model', efforts: ['low', 'high'] }]
    const opencode2 = vi.fn(async () => models)
    const exec = vi.fn(async () => '')
    expect(
      await probeAgentModels('opencode', {
        contexts: { opencode: context },
        opencode2,
        exec,
        timeoutMs: 9000,
      }),
    ).toEqual(models)
    expect(opencode2).toHaveBeenCalledWith(context, 9000)
    expect(exec).not.toHaveBeenCalled()
  })
})
