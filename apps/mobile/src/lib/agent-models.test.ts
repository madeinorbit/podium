import { describe, expect, it } from 'vitest'
import {
  allConnectorModelOptions,
  decodeModelPick,
  encodeModelPick,
  effortOptionsForModel,
  spawnSelection,
} from './agent-models'

describe('cross-harness model picks', () => {
  it('namespaces a model so opus on Claude and a custom opus cannot collide', () => {
    expect(encodeModelPick('claude-code', 'opus')).toBe('claude-code:opus')
    expect(decodeModelPick('claude-code:opus')).toEqual({
      agentKind: 'claude-code',
      model: 'opus',
    })
    expect(decodeModelPick('auto')).toEqual({ model: 'auto' })
  })

  it('lists every harness model under its connector, Auto first', () => {
    const options = allConnectorModelOptions()
    expect(options[0]).toEqual({ value: 'auto', label: 'Auto' })
    expect(options.some((o) => o.value === 'claude-code:opus' && o.group === 'Claude Code')).toBe(
      true,
    )
    expect(options.some((o) => o.value === 'codex:gpt-5.5' && o.group === 'Codex')).toBe(true)
    expect(options.some((o) => o.value === 'grok:grok-4.5' && o.group === 'Grok')).toBe(true)
  })

  it('hides effort for haiku and keeps the Claude ladder for opus', () => {
    expect(effortOptionsForModel('claude-code', 'haiku')).toEqual([])
    expect(effortOptionsForModel('claude-code', 'opus').map((o) => o.value)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('omits auto sentinels from the spawn payload', () => {
    expect(spawnSelection('auto', 'auto')).toEqual({})
    expect(spawnSelection('claude-code:opus', 'high')).toEqual({
      agentKind: 'claude-code',
      model: 'opus',
      effort: 'high',
    })
  })
})
