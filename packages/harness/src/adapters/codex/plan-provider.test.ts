/**
 * The provider a Codex session on a ChatGPT plan starts with (epic Task 15,
 * acceptance 1): OpenAI's documented settings, exactly as POD-6894 measured
 * them on Codex 0.169.0, and the token named only by its variable.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CHATGPT_PLAN_BASE_URL,
  CHATGPT_PLAN_TOKEN_VARIABLE,
  CODEX_PLAN_PROVIDER_ID,
  codexModelProviderChange,
  codexPlanProviderArgs,
} from './plan-provider.js'

describe('codexPlanProviderArgs', () => {
  it('selects the documented provider with the token read from ACCESS_TOKEN', () => {
    expect(CHATGPT_PLAN_TOKEN_VARIABLE).toBe('ACCESS_TOKEN')
    expect(CHATGPT_PLAN_BASE_URL).toBe('https://api.openai.com/v1')
    expect(codexPlanProviderArgs()).toEqual([
      '-c',
      `model_provider="${CODEX_PLAN_PROVIDER_ID}"`,
      '-c',
      `model_providers.${CODEX_PLAN_PROVIDER_ID}.name="ChatGPT plan"`,
      '-c',
      `model_providers.${CODEX_PLAN_PROVIDER_ID}.base_url="https://api.openai.com/v1"`,
      '-c',
      `model_providers.${CODEX_PLAN_PROVIDER_ID}.env_key="ACCESS_TOKEN"`,
      '-c',
      `model_providers.${CODEX_PLAN_PROVIDER_ID}.wire_api="responses"`,
      '-c',
      `model_providers.${CODEX_PLAN_PROVIDER_ID}.requires_openai_auth=false`,
      '-c',
      `model_providers.${CODEX_PLAN_PROVIDER_ID}.supports_websockets=false`,
    ])
  })

  it('points at another endpoint only when asked (tests use a local fake)', () => {
    expect(codexPlanProviderArgs('http://127.0.0.1:9/v1')).toContain(
      `model_providers.${CODEX_PLAN_PROVIDER_ID}.base_url="http://127.0.0.1:9/v1"`,
    )
  })
})

describe('the model provider recorded when moving a conversation', () => {
  it.each([
    ['openai.api-key', 'openai.chatgpt-plan', CODEX_PLAN_PROVIDER_ID],
    ['openai.chatgpt-plan', undefined, 'openai'],
    ['openai.chatgpt-plan', 'openai.chatgpt-plan', undefined],
    [undefined, 'openai.api-key', undefined],
  ])('rewrites %s to %s only when its provider changes', async (from, to, expected) => {
    expect(await codexModelProviderChange('codex', async () => ({ from, to }))).toBe(expected)
  })

  it('does not read credential types for a harness with another conversation format', async () => {
    const readTypes = vi.fn(async () => {
      throw new Error('unnecessary credential read')
    })
    expect(await codexModelProviderChange('claude-code', readTypes)).toBeUndefined()
    expect(readTypes).not.toHaveBeenCalled()
  })
})
