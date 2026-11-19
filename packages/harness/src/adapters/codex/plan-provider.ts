/**
 * CODEX ON A CHATGPT PLAN SIGNED IN TO PODIUM (credential management §11
 * "Codex"; epic Task 15).
 *
 * OpenAI's documented way to run `codex app-server` on a Sign in with ChatGPT
 * token: a model provider that reads the token from an environment variable.
 * Measured on Codex 0.169.0 (POD-6894 report §5): with these settings and the
 * token in `ACCESS_TOKEN`, a home with no Codex login answers turns, and Codex
 * writes no token and no `auth.json` into it.
 *
 * These are the arguments of the plan's accepted line (`startArgs`), so every
 * process start that carries the plan's token also names this provider. The
 * token itself is never an argument: only the variable's NAME is.
 */

/** The provider's id in Codex's config, and what `thread/start` reports as `modelProvider`. */
export const CODEX_PLAN_PROVIDER_ID = 'podium_chatgpt_plan'
/** Where a Sign in with ChatGPT token may call (§11). */
export const CHATGPT_PLAN_BASE_URL = 'https://api.openai.com/v1'
/** The variable the plan's token is delivered in. */
export const CHATGPT_PLAN_TOKEN_VARIABLE = 'ACCESS_TOKEN'

/**
 * `-c` overrides that select the provider. `baseUrl` exists for tests that
 * point Codex at a local fake endpoint; production uses OpenAI's.
 */
export function codexPlanProviderArgs(baseUrl: string = CHATGPT_PLAN_BASE_URL): string[] {
  const key = `model_providers.${CODEX_PLAN_PROVIDER_ID}`
  return [
    '-c',
    `model_provider=${JSON.stringify(CODEX_PLAN_PROVIDER_ID)}`,
    '-c',
    `${key}.name=${JSON.stringify('ChatGPT plan')}`,
    '-c',
    `${key}.base_url=${JSON.stringify(baseUrl)}`,
    '-c',
    `${key}.env_key=${JSON.stringify(CHATGPT_PLAN_TOKEN_VARIABLE)}`,
    '-c',
    `${key}.wire_api="responses"`,
    '-c',
    `${key}.requires_openai_auth=false`,
    '-c',
    `${key}.supports_websockets=false`,
  ]
}
