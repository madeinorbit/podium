import { AUTO, type ModelChoice } from '@podium/client-core/agent-models'
import { asAccountId, type AccountId, type AccountView } from '@podium/model/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { HarnessAgent, RoleBackend } from '@podium/runtime'
import { issueAgentDescriptors } from '@/lib/issue-agents'
import { managedCodingHarnesses } from '@/lib/managed-harness-pairing'

export type AgentGroup =
  | 'Signed in on your machines'
  | 'Using your API key'
  | 'Shared with you'

export interface AgentOption {
  value: string
  accountId: AccountId
  harness: HarnessAgent
  group: AgentGroup
  label: string
  hint: string
  help: string
}

export const providerNames: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

/** A picker value identifies both the credential and the CLI it authenticates. */
export function agentOptionValue(accountId: string, harness: string): string {
  return JSON.stringify([accountId, harness])
}

/** The account directory has already resolved own-key > shared-key precedence.
 * Only offer credentials it says are connected; never invent workspace keys. */
export function agentOptions(
  accounts: readonly AccountView[],
  nativeOnly = false,
  served?: readonly HarnessDescriptorWire[],
): AgentOption[] {
  const descriptors = issueAgentDescriptors(served)
  return accounts.flatMap((account): AgentOption[] => {
    if (account.status !== 'connected') return []
    const accountId = asAccountId(account.id)
    if (account.source === 'native' && account.harness) {
      const harness = account.harness
      const label = descriptors.find((d) => d.kind === harness)?.label ?? harness
      return [{
        value: agentOptionValue(accountId, harness),
        accountId,
        harness,
        group: 'Signed in on your machines',
        label,
        hint: [account.identity, account.machines?.join(', ')].filter(Boolean).join(' · '),
        help: 'Runs the CLI with the login already on the machine. Usage counts against that subscription or account.',
      }]
    }
    if (nativeOnly || account.source !== 'managed') return []
    const provider = providerNames[account.provider] ?? account.provider
    const shared = account.credentialSource === 'shared'
    const owner = account.sharedBy || 'another member'
    const credential = account.kind === 'oauth' ? 'subscription' : `${provider} key`
    return managedCodingHarnesses(accountId, descriptors).map((harness) => {
      const label = descriptors.find((d) => d.kind === harness)?.label ?? harness
      return {
        value: agentOptionValue(accountId, harness),
        accountId,
        harness,
        group: shared ? 'Shared with you' : 'Using your API key',
        label,
        hint: shared ? `${owner}’s ${credential}` : `your ${credential}`,
        help: shared
          ? `Runs ${label} with the ${credential} ${owner} shared. Used because you have no ${credential} of your own. Add your own under AI accounts to stop using theirs. ${account.kind === 'oauth' ? 'Usage counts against their subscription.' : 'Billed per token to their key.'}`
          : `Runs ${label} with your ${credential}. ${account.kind === 'oauth' ? 'Usage counts against your subscription.' : 'Billed per token.'}`,
      }
    })
  })
}

/** Keep a choice when the next catalog accepts it. With no report, changing
 * only the credential for the same harness is not evidence it became invalid. */
export function backendForAgent(
  backend: RoleBackend,
  currentHarness: HarnessAgent,
  next: Pick<AgentOption, 'accountId' | 'harness'>,
  reported?: readonly ModelChoice[],
): RoleBackend {
  const known = reported !== undefined && reported.length > 0
  const model = !backend.model || backend.model === AUTO
    ? AUTO
    : known
      ? reported.some((entry) => entry.value === backend.model) ? backend.model : AUTO
      : next.harness === currentHarness ? backend.model : AUTO
  const efforts = reported?.find((entry) => entry.value === model)?.efforts
  const effort = !backend.effort || backend.effort === AUTO
    ? AUTO
    : efforts
      ? efforts.includes(backend.effort) ? backend.effort : AUTO
      : !known && next.harness === currentHarness && model === backend.model ? backend.effort : AUTO
  return { ...backend, accountId: next.accountId, harness: next.harness, model, effort }
}

/** API providers have no model-directory endpoint. These small lists are only
 * for background work; native CLI choices always use their reported catalog. */
export const BACKGROUND_MODELS: Readonly<Record<string, readonly ModelChoice[]>> = {
  openrouter: [
    { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { value: 'openai/gpt-5-mini', label: 'GPT-5 mini' },
  ],
  anthropic: [
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  ],
  openai: [
    { value: 'gpt-5-mini', label: 'GPT-5 mini' },
    { value: 'gpt-5-nano', label: 'GPT-5 nano' },
  ],
}

export function backgroundDefaultModel(provider: string): string {
  return BACKGROUND_MODELS[provider]?.[0]?.value ?? 'google/gemini-2.5-flash'
}
