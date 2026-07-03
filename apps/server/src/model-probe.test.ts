import { describe, expect, it } from 'vitest'
import {
  parseCursorModels,
  parseGrokModels,
  parseOpencodeModels,
  probeAgentModels,
  probeAllModels,
} from './model-probe'

const GROK = `You are logged in with grok.com.

Default model: grok-composer-2.5-fast

Available models:
  * grok-composer-2.5-fast (default)
  - grok-build
`

const CURSOR = `Available models

auto - Auto
gpt-5.3-codex - Codex 5.3
composer-2.5 - Composer 2.5 (current)
glm-5.2-max - GLM 5.2 Max

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`

const OPENCODE = `opencode/big-pickle
openai/gpt-5.5
xai/grok-4.3
`

describe('model-probe parsers', () => {
  it('grok: reads the marker list under "Available models:", ignores header/default line', () => {
    expect(parseGrokModels(GROK)).toEqual([
      { value: 'grok-composer-2.5-fast', label: 'grok-composer-2.5-fast' },
      { value: 'grok-build', label: 'grok-build' },
    ])
  })

  it('cursor: parses "id - label", drops auto, strips (current)/(default), skips Tip line', () => {
    expect(parseCursorModels(CURSOR)).toEqual([
      { value: 'gpt-5.3-codex', label: 'Codex 5.3' },
      { value: 'composer-2.5', label: 'Composer 2.5' },
      { value: 'glm-5.2-max', label: 'GLM 5.2 Max' },
    ])
  })

  it('opencode: keeps only provider/model id lines', () => {
    expect(parseOpencodeModels(OPENCODE)).toEqual([
      { value: 'opencode/big-pickle', label: 'opencode/big-pickle' },
      { value: 'openai/gpt-5.5', label: 'openai/gpt-5.5' },
      { value: 'xai/grok-4.3', label: 'xai/grok-4.3' },
    ])
  })

  it('parsers tolerate empty / junk output', () => {
    expect(parseGrokModels('')).toEqual([])
    expect(parseCursorModels('nonsense\n')).toEqual([])
    expect(parseOpencodeModels('not a model line')).toEqual([])
  })
})

describe('probe (injected exec — no shelling out)', () => {
  it('returns parsed models on success', async () => {
    const models = await probeAgentModels('grok', { exec: async () => GROK })
    expect(models.map((m) => m.value)).toEqual(['grok-composer-2.5-fast', 'grok-build'])
  })

  it('swallows a failing/absent CLI as []', async () => {
    const models = await probeAgentModels('cursor', {
      exec: async () => {
        throw new Error('command not found')
      },
    })
    expect(models).toEqual([])
  })

  it('probeAllModels fans out and keys by agent kind', async () => {
    const byAgent = await probeAllModels({
      exec: async (argv) => {
        if (argv[0] === 'grok') return GROK
        if (argv[0] === 'cursor-agent') return CURSOR
        if (argv[0] === 'opencode') return OPENCODE
        return ''
      },
    })
    expect(Object.keys(byAgent).sort()).toEqual(['cursor', 'grok', 'opencode'])
    expect(byAgent.grok?.length).toBe(2)
    expect(byAgent.cursor?.length).toBe(3)
    expect(byAgent.opencode?.length).toBe(3)
  })
})
