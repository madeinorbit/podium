/**
 * The provider a Codex session on a ChatGPT plan starts with (epic Task 15,
 * acceptance 1): OpenAI's documented settings, exactly as POD-6894 measured
 * them on Codex 0.169.0, and the token named only by its variable.
 */
import { describe, expect, it } from 'vitest'
import {
  CHATGPT_PLAN_BASE_URL,
  CHATGPT_PLAN_TOKEN_VARIABLE,
  CODEX_PLAN_PROVIDER_ID,
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
