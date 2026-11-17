import { AUTO, type ModelChoice } from '@podium/client-core/agent-models'
import { asAccountId, type CredentialView } from '@podium/model/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import type { HarnessAgent, RoleBackend } from '@podium/runtime'
import { issueAgentDescriptors } from '@/lib/issue-agents'

/**
 * One choice of agent program for a role. The program is all the role picks:
 * the credential a session runs on is the one its launch names, then the
 * person's default for that program (Credentials), then the program's own
 * login on the machine (credential management §9 "Choosing for a session").
 */
export interface AgentOption {
  value: HarnessAgent
  harness: HarnessAgent
  label: string
  hint: string
  help: string
}

/** Every agent program this fleet serves, with who it is signed in as on the person's machines. */
export function agentOptions(
  accounts: readonly CredentialView[],
  served?: readonly HarnessDescriptorWire[],
): AgentOption[] {
  return issueAgentDescriptors(served).map((descriptor) => {
    const harness = descriptor.kind as HarnessAgent
    const logins = accounts.filter(
      (view) =>
        view.access === 'owner' &&
        view.nativeLogin?.harness === harness &&
        view.nativeLogin.machines.some((machine) => machine.state === 'in'),
    )
    const hint = [
      ...new Set(
        logins.flatMap((view) => [
          view.identity.email,
          view.nativeLogin?.machines
            .filter((machine) => machine.state === 'in')
            .map((machine) => machine.name)
            .join(', '),
        ]),
      ),
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      value: harness,
      harness,
      label: descriptor.label,
      hint,
      help: `Runs ${descriptor.label} on your default credential for it (set under Credentials), or on the login already on the machine.`,
    }
  })
}

/** Keep a choice when the next catalog accepts it. With no report, picking the
 * same harness again is not evidence it became invalid. The pick clears an
 * account id saved before credentials (`roles.<role>.accountId`), which would
 * otherwise keep deciding the harness; nothing writes a new one. */
export function backendForAgent(
  backend: RoleBackend,
  currentHarness: HarnessAgent,
  next: Pick<AgentOption, 'harness'>,
  reported?: readonly ModelChoice[],
): RoleBackend {
  const known = reported !== undefined && reported.length > 0
  const model =
    !backend.model || backend.model === AUTO
      ? AUTO
      : known
        ? reported.some((entry) => entry.value === backend.model)
          ? backend.model
          : AUTO
        : next.harness === currentHarness
          ? backend.model
          : AUTO
  const efforts = (
    model === AUTO ? reported?.[0] : reported?.find((entry) => entry.value === model)
  )?.efforts
  const effort =
    !backend.effort || backend.effort === AUTO
      ? AUTO
      : efforts
        ? efforts.includes(backend.effort)
          ? backend.effort
          : AUTO
        : !known && next.harness === currentHarness && model === backend.model
          ? backend.effort
          : AUTO
  return { ...backend, accountId: asAccountId(''), harness: next.harness, model, effort }
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
