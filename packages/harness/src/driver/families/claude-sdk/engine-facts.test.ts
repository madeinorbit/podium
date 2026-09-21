// The claude engine facts, read off handed sections — never the registry.

import { describe, expect, it } from 'vitest'
import { manifestFor } from '../../../registry.js'
import { claudeEngineFacts, claudeEngineProcessKey } from './engine-facts.js'

describe('the claude engine facts', () => {
  it('reads the executable and credential strip list off the adapter inventory', () => {
    const manifest = manifestFor('claude-code')
    expect(manifest).toBeDefined()
    const facts = claudeEngineFacts({ kind: manifest!.kind, inventory: manifest!.inventory })
    expect(facts).toMatchObject({
      harnessKind: 'claude-code',
      command: 'claude',
      scopeToken: 'cl',
      journalNamespace: 'claude-engines',
    })
    expect(facts.stripEnv).toContain('ANTHROPIC_API_KEY')
  })

  it('throws honestly when the adapter stops declaring the executable', () => {
    expect(() =>
      claudeEngineFacts({
        kind: 'claude-code',
        inventory: { executable: { names: [] } } as unknown as Parameters<
          typeof claudeEngineFacts
        >[0]['inventory'],
      }),
    ).toThrow(/inventory.executable.names/)
  })

  it('derives the durable label from the Podium session id', () => {
    const manifest = manifestFor('claude-code')
    const facts = claudeEngineFacts({ kind: manifest!.kind, inventory: manifest!.inventory })
    expect(claudeEngineProcessKey(facts, 'abc-123')).toBe('podium-cl-abc-123')
  })
})
