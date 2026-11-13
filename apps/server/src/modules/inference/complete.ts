/**
 * DIRECT INFERENCE: THE ONE ENTRY POINT FOR PODIUM'S OWN MODEL CALLS
 * (credential management spec §9 "Direct inference", §5 routes).
 *
 * A feature that calls a model without a harness (the issue assistant today)
 * names a credential, or a role whose settings name one, and the acting
 * person. This module chooses the credential, asks the resolver whether that
 * person may use it and by which route, and runs the call:
 *
 *  - `http`: the server calls the provider with the secret, read through
 *    `withSecret` for the length of the call and never kept, logged or thrown;
 *  - `on-machine`: the machine whose harness home holds the login runs the
 *    call and only the answer comes back (`codex-machine.ts`, POD-4750).
 *
 * A refused credential throws `CredentialRefusal`; nothing falls back to
 * another key or login. Every answer says which credential served it
 * (`servedBy`, `label`), and one usage line per call records it.
 */

import { bundledDescriptorFor, effectiveCatalogModel } from '@podium/harness/browser'
import { harnessAccepts } from '@podium/harness/metadata'
import { createLogger } from '@podium/logger'
import {
  type CredentialId,
  type CredentialTypeId,
  HarnessAgent,
  INFERENCE_ROUTES,
  type InferenceRoute,
  type MachineId,
  type RoleName,
  type UserId,
} from '@podium/model'
import { type PodiumSettings, resolveRole } from '@podium/runtime'
import {
  type CodexLoginMachineSource,
  type CodexTurnResult,
  pickLoginMachine,
} from '../../codex-machine'
import {
  anthropicMessages,
  type FetchLike,
  type LlmAnswer,
  type LlmMessage,
  type LlmTool,
  OPENAI_BASE,
  OPENROUTER_BASE,
  openaiChat,
  type ToolCall,
} from '../../llm'
import { LlmConfigError } from '../../llm-error'
import type { SessionStore } from '../../store'
import type { CredentialRecord } from '../../store/credentials'
import {
  ACCESS_REFUSAL_MESSAGES,
  type AccessDeps,
  refuse,
  resolveInferenceAccess,
} from '../credentials/access'
import { classifyCredentialFailure, httpStatusOf } from '../credentials/health'
import { credentialIdFromLegacy } from '../credentials/legacy-ids'
import { SecretUnavailableError, withSecret } from '../credentials/vault'
import { CredentialRefusal } from '../sessions/launch-config'

const log = createLogger('server:inference')

export interface CompleteInput {
  /** The credential to run on. When absent, the role's settings name it. */
  credentialId?: CredentialId
  /** The role (background, superagent) whose settings name the credential and model. */
  role?: RoleName
  /** Overrides the role's model. */
  model?: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  /** The person the call acts for: their settings, their right to use the credential. */
  actingUserId: UserId
}

export interface CompleteResult {
  text: string
  toolCalls: ToolCall[]
  /** The credential that answered. */
  servedBy: CredentialId
  /** Its label, as the person named it. */
  label: string
}

/**
 * How an `on-machine` call reaches the machine that holds the login. Built
 * by the composition root over the daemon RPC; absent, an on-machine
 * credential is not configured here.
 */
export interface OnMachineTransport {
  listMachines(): Promise<readonly CodexLoginMachineSource[]>
  isOnline(id: MachineId): boolean
  /** The fleet default, preferred when it holds the login. */
  defaultMachineId(): Promise<MachineId | undefined>
  codexComplete(
    machineId: MachineId,
    input: {
      model: string
      messages: LlmMessage[]
      tools: LlmTool[]
      effort: 'low' | 'medium' | 'high'
    },
  ): Promise<CodexTurnResult>
}

export interface CompleteDeps {
  /** A SessionStore satisfies it. */
  store: AccessDeps & Pick<SessionStore, 'vault' | 'settings'>
  fetch?: FetchLike
  onMachine?: OnMachineTransport
  /**
   * The provider rejected the credential, or reported a limit (credential
   * management §7): the health service records it. Absent, nothing is recorded.
   */
  onCredentialFailure?: (failure: {
    credentialId: CredentialId
    failure: 'rejected' | 'limit'
    reason: string
    actorUserId: UserId
  }) => Promise<void>
}

/** No credential is chosen, or the chosen one cannot serve this call here. */
export class InferenceNotConfigured extends LlmConfigError {
  override readonly name = 'InferenceNotConfigured'
}

/** The message of the usage line, the cost record of a direct call. */
export const INFERENCE_USAGE_MESSAGE = 'inference usage'

export interface InferenceUsage {
  servedBy: CredentialId
  label: string
  actingUserId: UserId
  /** `role` is the process role in every log record, so the call's role has its own key. */
  inferenceRole: RoleName | null
  model: string
  route: string
  machineId?: MachineId
  inputTokens: number | null
  outputTokens: number | null
}

/**
 * The cost record of one direct call: one structured info line. The one
 * place it is written, so a later table replaces it here. Never a secret.
 */
export function recordInferenceUsage(usage: InferenceUsage): void {
  log.info(INFERENCE_USAGE_MESSAGE, { ...usage })
}

/** Run one model call on the credential the input or its role names. */
export async function complete(deps: CompleteDeps, i: CompleteInput): Promise<CompleteResult> {
  const settings = i.role ? await deps.store.settings.getSettingsFor(i.actingUserId) : undefined
  const credentialId =
    i.credentialId ??
    (i.role && settings ? await roleCredential(deps, settings, i.role, i.actingUserId) : undefined)
  if (!credentialId) {
    throw new InferenceNotConfigured(
      i.role
        ? `no credential is chosen for the ${i.role} role — pick one in Settings → Credentials`
        : 'no credential was named for this model call',
    )
  }
  const access = await resolveInferenceAccess(deps.store, {
    credentialId,
    actingUserId: i.actingUserId,
  })
  if (!access.ok) throw new CredentialRefusal(access.refusal, access.message)
  const credential = await deps.store.credentials.get(access.credentialId)
  if (!credential) throw new CredentialRefusal('not-found', ACCESS_REFUSAL_MESSAGES['not-found'])
  const role = i.role && settings ? settings.roles[i.role] : undefined
  const call: RouteCall = {
    credential,
    model: i.model ?? role?.model ?? 'auto',
    effort: role?.effort ?? 'auto',
    messages: i.messages,
    tools: i.tools ?? [],
    actingUserId: i.actingUserId,
  }
  let served: Served
  try {
    served = await runRoute(deps, access.route, call)
  } catch (err) {
    await reportCredentialFailure(deps, credential.id, i.actingUserId, err)
    throw err
  }
  recordInferenceUsage({
    servedBy: credential.id,
    label: credential.label,
    actingUserId: i.actingUserId,
    inferenceRole: i.role ?? null,
    model: served.model,
    route: routeName(access.route),
    ...(served.machineId ? { machineId: served.machineId } : {}),
    inputTokens: served.answer.usage?.inputTokens ?? null,
    outputTokens: served.answer.usage?.outputTokens ?? null,
  })
  return {
    text: served.answer.text,
    toolCalls: served.answer.toolCalls,
    servedBy: credential.id,
    label: credential.label,
  }
}

/**
 * A provider's answer that names the credential: 401/403 rejects it, 429/402
 * is a limit. The error was already redacted of the secret. A failure to record
 * it is logged and never replaces the call's own error.
 */
async function reportCredentialFailure(
  deps: CompleteDeps,
  credentialId: CredentialId,
  actorUserId: UserId,
  err: unknown,
): Promise<void> {
  if (!deps.onCredentialFailure || err instanceof CredentialRefusal) return
  const failure = classifyCredentialFailure({ httpStatus: httpStatusOf(err) })
  if (failure === 'other') return
  try {
    await deps.onCredentialFailure({
      credentialId,
      failure,
      reason: err instanceof Error ? err.message : String(err),
      actorUserId,
    })
  } catch (recordErr) {
    log.warn('could not record a credential failure', { err: recordErr, credentialId })
  }
}

interface RouteCall {
  credential: CredentialRecord
  model: string
  effort: string
  messages: LlmMessage[]
  tools: LlmTool[]
  actingUserId: UserId
}

interface Served {
  answer: LlmAnswer
  model: string
  machineId?: MachineId
}

const routeName = (route: InferenceRoute): string =>
  route.kind === 'http'
    ? `http:${route.api}${route.base ? `:${route.base}` : ''}`
    : route.kind === 'on-machine'
      ? `on-machine:${route.api}`
      : `harness-one-shot:${route.harness}`

async function runRoute(
  deps: CompleteDeps,
  route: InferenceRoute,
  call: RouteCall,
): Promise<Served> {
  switch (route.kind) {
    case 'http':
      return await runHttp(deps, route, call)
    case 'on-machine':
      return await runOnMachine(deps, call)
    case 'harness-one-shot':
      // No type declares this route until measurement S5 passes (epic Task 6).
      throw new InferenceNotConfigured("This credential cannot serve Podium's own model calls yet.")
  }
}

async function runHttp(
  deps: CompleteDeps,
  route: Extract<InferenceRoute, { kind: 'http' }>,
  call: RouteCall,
): Promise<Served> {
  if (route.api === 'openai-responses') {
    // The ChatGPT plan's adapter arrives with epic Task 14.
    throw new InferenceNotConfigured("This credential cannot serve Podium's own model calls yet.")
  }
  if (!call.model || call.model === 'auto') {
    throw new InferenceNotConfigured(
      'no model is chosen for this call — pick one in Settings → Agents → Background model',
    )
  }
  const fetchImpl = deps.fetch ?? fetch
  const answer = await withProviderSecret(deps, call, async (key) =>
    route.api === 'anthropic-messages'
      ? await anthropicMessages(fetchImpl, key, call.model, call.messages, call.tools)
      : await openaiChat(
          fetchImpl,
          route.base === 'openrouter' ? OPENROUTER_BASE : OPENAI_BASE,
          key,
          call.model,
          call.messages,
          call.tools,
        ),
  )
  return { answer, model: call.model }
}

/**
 * Read the secret for the length of one provider call. A vault refusal
 * becomes the resolver's sentence; any error that quotes the secret (a
 * provider echoing a rejected key) is rethrown with it replaced.
 */
async function withProviderSecret<T>(
  deps: CompleteDeps,
  call: Pick<RouteCall, 'credential' | 'actingUserId'>,
  use: (secret: string) => Promise<T>,
): Promise<T> {
  const credentialId = call.credential.id
  try {
    return await withSecret(deps.store, credentialId, async (secret) => {
      try {
        return await use(secret)
      } catch (err) {
        throw redacted(err, secret)
      }
    })
  } catch (err) {
    if (err instanceof SecretUnavailableError) {
      const reason =
        err.reason === 'not-found' || err.reason === 'revoked' ? err.reason : 'needs-attention'
      const refused = await refuse(deps.store, reason, {
        credentialId,
        actingUserId: call.actingUserId,
      })
      throw new CredentialRefusal(refused.refusal, refused.message)
    }
    throw err
  }
}

const REDACTED = '[redacted]'

function redacted(err: unknown, secret: string): unknown {
  if (!(err instanceof Error)) {
    return typeof err === 'string' ? new Error(err.split(secret).join(REDACTED)) : err
  }
  const text = `${err.message}\n${err.stack ?? ''}`
  if (!text.includes(secret)) return err
  const clean = new Error(err.message.split(secret).join(REDACTED))
  clean.name = err.name
  clean.stack = (err.stack ?? '').split(secret).join(REDACTED)
  return clean
}

/** The harness that keeps this credential type's login in a home (codex for a ChatGPT login). */
function homeHarnessOf(type: string): HarnessAgent | undefined {
  return HarnessAgent.options.find((harness) =>
    harnessAccepts(harness).some((line) => line.type === type && line.deliver.kind === 'home'),
  )
}

const effortOf = (effort: string): 'low' | 'medium' | 'high' =>
  effort === 'low' || effort === 'high' ? effort : 'medium'

/**
 * Run the call on the machine whose harness reports this login (its
 * fingerprint), signed in, where the credential may be used: its owner holds
 * custody of the machine, or the owner sent it there. The login never leaves
 * that machine.
 */
async function runOnMachine(deps: CompleteDeps, call: RouteCall): Promise<Served> {
  const harness = homeHarnessOf(call.credential.type)
  const fingerprint = call.credential.identity.fingerprint
  if (!deps.onMachine || !harness || !fingerprint) {
    throw new InferenceNotConfigured(
      "This credential cannot serve Podium's own model calls on this server.",
    )
  }
  const transport = deps.onMachine
  const holding = (await transport.listMachines()).filter((machine) =>
    holdsLogin(machine, harness, fingerprint),
  )
  const allowed: CodexLoginMachineSource[] = []
  for (const machine of holding) {
    if (
      (await deps.store.machines.custodian(machine.id)) === call.credential.ownerUserId ||
      (await deps.store.credentials.isMachineAllowed(call.credential.id, machine.id))
    ) {
      allowed.push(machine)
    }
  }
  const picked = pickLoginMachine(allowed, {
    isOnline: (id) => transport.isOnline(id),
    defaultMachineId: await transport.defaultMachineId(),
    label: call.credential.label,
  })
  const model =
    call.model && call.model !== 'auto'
      ? call.model
      : effectiveCatalogModel(bundledDescriptorFor(harness), call.model)
  if (!model) {
    throw new InferenceNotConfigured(
      `no model catalog for ${harness} — pick an explicit model in Settings → Agents → Background model.`,
    )
  }
  const result = await transport.codexComplete(picked.machineId, {
    model,
    messages: call.messages,
    tools: call.tools,
    effort: effortOf(call.effort),
  })
  if (!result.ok) throw new LlmConfigError(result.error ?? 'The model call on the machine failed.')
  return {
    answer: { text: result.text ?? '', toolCalls: result.toolCalls ?? [] },
    model,
    machineId: picked.machineId,
  }
}

function holdsLogin(
  machine: CodexLoginMachineSource,
  harness: HarnessAgent,
  fingerprint: string,
): boolean {
  if (machine.revokedAt) return false
  return (machine.inventory?.agents ?? []).some(
    (agent) =>
      agent.kind === harness &&
      agent.login.state === 'in' &&
      agent.login.identity?.fingerprint === fingerprint,
  )
}

/**
 * The credential a role's direct calls run on: its `credentialId`; else the
 * account id it held before credentials existed. `undefined`: no credential.
 */
async function roleCredential(
  deps: CompleteDeps,
  settings: PodiumSettings,
  role: RoleName,
  actingUserId: UserId,
): Promise<CredentialId | undefined> {
  const chosen = settings.roles[role].credentialId
  if (chosen) return chosen
  return await legacyRoleCredential(deps, settings, role, actingUserId)
}

// LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
/**
 * A role setting from before credentials: `roles.<role>.accountId`, or the
 * role's default when it is empty (`managed:openrouter` for background). A
 * stored key resolves to the credential imported from it; a harness login
 * with a fingerprint to that login's credential. A default that finds nothing
 * is "not configured", as an unconfigured key was; an id the person chose that
 * names a key which no longer exists is refused with `not-found`.
 */
async function legacyRoleCredential(
  deps: CompleteDeps,
  settings: PodiumSettings,
  role: RoleName,
  actingUserId: UserId,
): Promise<CredentialId | undefined> {
  const stored = settings.roles[role].accountId
  const accountId = resolveRole(settings, role).accountId
  const found =
    (await credentialIdFromLegacy(deps.store, accountId, actingUserId)) ??
    (await ownLoginCredential(deps, accountId, actingUserId))
  if (found) return found
  if (stored === '' || accountId.startsWith('native:')) return undefined
  const refused = await refuse(deps.store, 'not-found', { credentialId: null, actingUserId })
  throw new CredentialRefusal(refused.refusal, refused.message)
}

// LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
/**
 * `native:<harness>` with no fingerprint: "my login for that harness", which
 * a background role on Codex meant before credentials (POD-4750). It reads as
 * the credential of the login on a machine the acting person holds custody
 * of (the fleet default first), the same machines a session with no
 * credential may use. None: no credential.
 */
async function ownLoginCredential(
  deps: CompleteDeps,
  accountId: string,
  actingUserId: UserId,
): Promise<CredentialId | undefined> {
  const harness = /^native:([^:]+)$/.exec(accountId)?.[1]
  if (!harness || !deps.onMachine) return undefined
  const type = harnessAccepts(harness).find(
    (line) => line.deliver.kind === 'home' && INFERENCE_ROUTES[line.type as CredentialTypeId],
  )?.type
  if (!type) return undefined
  const defaultMachineId = await deps.onMachine.defaultMachineId()
  const machines = [...(await deps.onMachine.listMachines())]
    .filter((machine) => !machine.revokedAt)
    .sort(
      (a, b) =>
        Number(b.id === defaultMachineId) - Number(a.id === defaultMachineId) ||
        a.name.localeCompare(b.name),
    )
  for (const machine of machines) {
    const fingerprint = machine.inventory?.agents.find(
      (agent) => agent.kind === harness && agent.login.state === 'in',
    )?.login.identity?.fingerprint
    if (!fingerprint) continue
    if ((await deps.store.machines.custodian(machine.id)) !== actingUserId) continue
    const credential = await deps.store.credentials.findByIdentity({
      ownerUserId: actingUserId,
      type,
      fingerprint,
    })
    if (credential) return credential.id
  }
  return undefined
}
