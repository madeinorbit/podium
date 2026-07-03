import { describe, expect, it } from 'vitest'
import {
  type FetchLike,
  parseCodexModels,
  parseCursorModels,
  parseGrokModels,
  parseOpencodeModels,
  probeAgentModels,
  probeAllModels,
  probeClaudeModels,
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

const CODEX = JSON.stringify({
  models: [
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', priority: 16 },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 7 },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      visibility: 'hide',
      priority: 43,
    },
  ],
})

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

  it('codex: parses debug-models JSON, drops hidden models, orders by priority', () => {
    expect(parseCodexModels(CODEX)).toEqual([
      { value: 'gpt-5.5', label: 'GPT-5.5' }, // priority 7 sorts before 16
      { value: 'gpt-5.4', label: 'GPT-5.4' },
    ])
  })

  it('parsers tolerate empty / junk output', () => {
    expect(parseGrokModels('')).toEqual([])
    expect(parseCursorModels('nonsense\n')).toEqual([])
    expect(parseOpencodeModels('not a model line')).toEqual([])
    expect(parseCodexModels('not json')).toEqual([])
  })
})

const claudeFetch =
  (status: number, data: unknown): FetchLike =>
  async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) })

/** A claude /v1/models mock that records the auth headers it was called with. */
function capturingClaudeFetch(status: number, data: unknown) {
  const calls: Array<Record<string, string>> = []
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(init.headers)
    return { ok: status >= 200 && status < 300, status, json: async () => ({ data }) }
  }
  return { fetchImpl, calls }
}

describe('probeClaudeModels (Anthropic /v1/models — subscription OAuth OR API key)', () => {
  const MODELS = [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }]

  it('subscription: sends the OAuth token as a Bearer token', async () => {
    const { fetchImpl, calls } = capturingClaudeFetch(200, MODELS)
    const models = await probeClaudeModels({ token: 'oat-123', fetchImpl })
    expect(models).toEqual([{ value: 'claude-sonnet-5', label: 'Claude Sonnet 5' }])
    expect(calls[0]?.authorization).toBe('Bearer oat-123')
    expect(calls[0]?.['x-api-key']).toBeUndefined()
  })

  it('API-based: sends x-api-key, and the key wins over any OAuth token', async () => {
    const { fetchImpl, calls } = capturingClaudeFetch(200, MODELS)
    const models = await probeClaudeModels({
      apiKey: 'sk-ant-api-key',
      token: 'oat-ignored',
      fetchImpl,
    })
    expect(models).toEqual([{ value: 'claude-sonnet-5', label: 'Claude Sonnet 5' }])
    expect(calls[0]?.['x-api-key']).toBe('sk-ant-api-key')
    expect(calls[0]?.authorization).toBeUndefined()
  })

  it('returns [] when neither an API key nor a token is available (→ static fallback)', async () => {
    const { fetchImpl } = capturingClaudeFetch(200, MODELS)
    expect(await probeClaudeModels({ token: null, fetchImpl })).toEqual([])
  })

  it('returns [] on a 401 without throwing', async () => {
    const { fetchImpl } = capturingClaudeFetch(401, null)
    expect(await probeClaudeModels({ token: 't', fetchImpl })).toEqual([])
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

  it('probeAllModels fans out over all five agents, keyed by agent kind', async () => {
    const byAgent = await probeAllModels({
      exec: async (argv) => {
        if (argv[0] === 'grok') return GROK
        if (argv[0] === 'cursor-agent') return CURSOR
        if (argv[0] === 'opencode') return OPENCODE
        if (argv[0] === 'codex') return CODEX
        return ''
      },
      claude: {
        token: 'sk-ant-oat01-test',
        fetchImpl: claudeFetch(200, [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }]),
      },
    })
    expect(Object.keys(byAgent).sort()).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'grok',
      'opencode',
    ])
    expect(byAgent['claude-code']?.[0]?.value).toBe('claude-sonnet-5')
    expect(byAgent.codex?.length).toBe(2)
  })

  it('omits claude-code when the OAuth call yields nothing (static fallback)', async () => {
    const byAgent = await probeAllModels({
      exec: async () => '',
      claude: { token: null, fetchImpl: claudeFetch(200, []) },
    })
    expect(byAgent['claude-code']).toBeUndefined()
  })
})
