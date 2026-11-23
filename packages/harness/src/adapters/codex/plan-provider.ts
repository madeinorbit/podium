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

/** The model-provider vocabulary recorded in a moved Codex thread. */
export function codexModelProvider(credentialType: string | undefined): string {
  return credentialType === 'openai.chatgpt-plan' ? CODEX_PLAN_PROVIDER_ID : 'openai'
}

/** A provider rewrite is a Codex file-format concern; other harnesses need no credential reads. */
export async function codexModelProviderChange(
  harness: string,
  readTypes: () => Promise<{ from: string | undefined; to: string | undefined }>,
): Promise<string | undefined> {
  if (harness !== 'codex') return undefined
  const types = await readTypes()
  const from = codexModelProvider(types.from)
  const to = codexModelProvider(types.to)
  return from === to ? undefined : to
}

/**
 * `-c` overrides that select the provider. `baseUrl` exists for tests that
 * point Codex at a local fake endpoint; production uses OpenAI's.
 */
export function codexPlanProviderArgs(baseUrl: string = CHATGPT_PLAN_BASE_URL): string[] {
  return envKeyProviderArgs(
    CODEX_PLAN_PROVIDER_ID,
    'ChatGPT plan',
    baseUrl,
    CHATGPT_PLAN_TOKEN_VARIABLE,
  )
}

/**
 * CODEX ON AN OPENAI API KEY IN THE PODIUM HOME (managed installs §4.3,
 * measured in POD-7267). The Podium home holds no Codex login, and Codex's
 * built-in `openai` provider reads only the login file: with the bare
 * `OPENAI_API_KEY` a terminal shows the sign-in menu. A provider that reads
 * the key from that variable answers the first turn. Only the variable's
 * NAME is an argument.
 */
export const CODEX_API_KEY_PROVIDER_ID = 'podium_openai_api_key'
export const OPENAI_API_KEY_VARIABLE = 'OPENAI_API_KEY'

export function codexApiKeyProviderArgs(baseUrl: string = CHATGPT_PLAN_BASE_URL): string[] {
  return envKeyProviderArgs(
    CODEX_API_KEY_PROVIDER_ID,
    'OpenAI API key',
    baseUrl,
    OPENAI_API_KEY_VARIABLE,
  )
}

/**
 * The provider a thread must record to resume in the Podium home: Codex's
 * built-in `openai` cannot answer there (no login file), so a thread recorded
 * under it continues on the API-key provider. Any other provider stays.
 */
export function codexProviderInPodiumHome(provider: string): string {
  return provider === 'openai' ? CODEX_API_KEY_PROVIDER_ID : provider
}

function envKeyProviderArgs(id: string, name: string, baseUrl: string, envKey: string): string[] {
  const key = `model_providers.${id}`
  return [
    '-c',
    `model_provider=${JSON.stringify(id)}`,
    '-c',
    `${key}.name=${JSON.stringify(name)}`,
    '-c',
    `${key}.base_url=${JSON.stringify(baseUrl)}`,
    '-c',
    `${key}.env_key=${JSON.stringify(envKey)}`,
    '-c',
    `${key}.wire_api="responses"`,
    '-c',
    `${key}.requires_openai_auth=false`,
    '-c',
    `${key}.supports_websockets=false`,
  ]
}
