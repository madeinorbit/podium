/**
 * CHARACTERISATION: the production engine facts, byte for byte (POD-4494).
 *
 * Recorded 2026-09-21 on integrate/4414-single-harness-transport at e087e2a93
 * with the no-argument `*EngineFacts()` readers. The refactor hands each reader
 * its adapter sections instead of letting it fetch the registry by name; the
 * projection must not move. If this file is red, a production harness's argv,
 * env strip list, scope token or journal namespace changed — say so out loud
 * rather than updating the snapshot quietly.
 */

import { describe, expect, it } from 'vitest'
import { manifestFor } from '../../registry.js'
import { codexEngineFacts } from './codex/engine-facts.js'
import { grokEngineFacts } from './grok-acp/engine-facts.js'
import { opencode2Flavor, opencodeFlavor } from './opencode/engine-facts.js'

function sectionsOf(kind: 'codex' | 'grok' | 'opencode') {
  const manifest = manifestFor(kind)
  if (!manifest) throw new Error(`no harness adapter for '${kind}'`)
  return { kind: manifest.kind, runtime: manifest.runtime, inventory: manifest.inventory }
}

describe('production engine facts are byte-identical through the handover', () => {
  it('codex', () => {
    const facts = codexEngineFacts(sectionsOf('codex'))
    expect(facts).toEqual({
      harnessKind: 'codex',
      command: 'codex',
      serverArgs: ['app-server'],
      executableName: 'codex',
      stripEnv: [
        'OPENAI_API_KEY',
        'CODEX_API_KEY',
        'CODEX_ACCESS_TOKEN',
        'OPENAI_ORGANIZATION',
        'OPENAI_ORG_ID',
        'OPENAI_BASE_URL',
      ],
      scopeToken: 'cx',
      journalNamespace: 'codex-app-servers',
      attachKind: 'codex',
    })
  })

  it('grok', () => {
    const facts = grokEngineFacts(sectionsOf('grok'))
    expect(facts).toEqual({
      harnessKind: 'grok',
      command: 'grok',
      serverArgs: ['agent', 'stdio'],
      executableName: 'grok',
      stripEnv: ['XAI_API_KEY'],
      scopeToken: 'gk',
      journalNamespace: 'grok-acp-servers',
      attachKind: 'grok',
    })
  })

  it('opencode stable speaker', () => {
    const flavor = opencodeFlavor(sectionsOf('opencode'))
    const { serveArgs, extraEnv, ...rest } = flavor
    expect(rest).toEqual({
      driverId: 'opencode-server',
      harnessKind: 'opencode',
      executableName: 'opencode',
      username: 'podium',
      healthPath: '/global/health',
      stripEnv: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_GENERATIVE_AI_API_KEY',
        'GROQ_API_KEY',
        'XAI_API_KEY',
        'MISTRAL_API_KEY',
        'DEEPSEEK_API_KEY',
      ],
      scopeToken: 'oc',
      journalNamespace: 'opencode-servers',
      attachKind: 'opencode',
    })
    expect(extraEnv()).toEqual({})
    expect(serveArgs('RESOLVED', 41234)).toEqual([
      'RESOLVED',
      'serve',
      '--port',
      '41234',
      '--hostname',
      '127.0.0.1',
    ])
  })

  it('opencode preview speaker', () => {
    const flavor = opencode2Flavor(sectionsOf('opencode'))
    const { serveArgs, extraEnv, ...rest } = flavor
    expect(rest).toEqual({
      driverId: 'opencode2-server',
      harnessKind: 'opencode',
      executableName: 'opencode2',
      username: 'opencode',
      healthPath: '/api/health',
      stripEnv: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_GENERATIVE_AI_API_KEY',
        'GROQ_API_KEY',
        'XAI_API_KEY',
        'MISTRAL_API_KEY',
        'DEEPSEEK_API_KEY',
      ],
      scopeToken: 'oc2',
      journalNamespace: 'opencode2-servers',
      attachKind: 'opencode',
    })
    expect(extraEnv()).toEqual({ OPENCODE_DISABLE_AUTOUPDATE: '1' })
    expect(serveArgs('RESOLVED2', 49999)).toEqual([
      'RESOLVED2',
      'serve',
      '--port',
      '49999',
      '--hostname',
      '127.0.0.1',
    ])
  })
})
