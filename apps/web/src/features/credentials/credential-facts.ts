/**
 * What the credentials page says about a credential, as plain functions
 * (credential management §4, §5, §7, §8). Type facts come from the registry
 * (`CREDENTIAL_TYPES`), direct-inference routes from `INFERENCE_ROUTES`, and
 * what a harness accepts from its served descriptor. A `type` this build does
 * not know (a newer server's) is shown by its id and offered nowhere.
 */

import {
  CREDENTIAL_TYPE_IDS,
  CREDENTIAL_TYPES,
  type CredentialTypeId,
  type CredentialTypeSpec,
  type CredentialView,
  INFERENCE_ROUTES,
  isCredentialTypeId,
} from '@podium/model'

/** A recorded expiry closer than this is shown as a warning (spec §7: a warning two weeks before). */
export const EXPIRING_SOON_DAYS = 14
const DAY_MS = 86_400_000

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

export function typeSpecOf(type: string): CredentialTypeSpec | undefined {
  return isCredentialTypeId(type) ? CREDENTIAL_TYPES[type] : undefined
}

export function typeTitle(type: string): string {
  return typeSpecOf(type)?.title ?? type
}

export function providerName(type: string): string {
  const provider = typeSpecOf(type)?.provider
  return provider ? (PROVIDER_NAMES[provider] ?? provider) : 'the provider'
}

/** Subscription kinds (a login, a token or a plan) as opposed to a key billed per token. */
export function isSubscription(type: string): boolean {
  return typeSpecOf(type)?.sharing === 'warn'
}

export interface StatusLine {
  tone: 'ok' | 'warn' | 'muted'
  text: string
}

export interface StatusContext {
  now: number
  ownerName: (userId: string) => string | undefined
  machineName: (machineId: string) => string
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Every line that applies, most urgent first; "Ready" when nothing needs saying. */
export function statusLines(view: CredentialView, ctx: StatusContext): StatusLine[] {
  const lines: StatusLine[] = []
  if (view.status === 'attention') {
    lines.push({
      tone: 'warn',
      text: `Needs attention: ${view.statusReason ?? 'it stopped working.'}`,
    })
  }
  if (view.limitReachedUntil && Date.parse(view.limitReachedUntil) > ctx.now) {
    lines.push({ tone: 'warn', text: `Limit reached until ${formatTime(view.limitReachedUntil)}` })
  }
  if (view.expiresAt) {
    const left = Date.parse(view.expiresAt) - ctx.now
    if (left <= 0) lines.push({ tone: 'warn', text: 'Expired' })
    else if (left <= EXPIRING_SOON_DAYS * DAY_MS) {
      const days = Math.max(1, Math.round(left / DAY_MS))
      lines.push({ tone: 'warn', text: `Expires in ${days} ${days === 1 ? 'day' : 'days'}` })
    }
  }
  for (const home of view.homes) {
    if (home.state === 'removal-pending') {
      lines.push({ tone: 'warn', text: `Removal pending on ${ctx.machineName(home.machineId)}` })
    }
  }
  if (lines.length === 0) lines.push({ tone: 'ok', text: 'Ready' })
  if (view.access !== 'owner') {
    const owner = ctx.ownerName(view.ownerUserId) ?? 'another member'
    lines.push({
      tone: 'muted',
      text:
        view.access === 'use'
          ? `Shared with you by ${owner}`
          : `${owner}’s, shared for you to manage`,
    })
  }
  return lines
}

/** What `credentials.list` returned, without removed credentials. */
export function listed(views: readonly CredentialView[]): CredentialView[] {
  return views.filter((view) => view.status !== 'revoked')
}

/** What removing it does and does not do at the provider, from the type's `revocation`. */
export function removalSentence(type: string): string {
  const spec = typeSpecOf(type)
  const provider = providerName(type)
  switch (spec?.revocation) {
    case 'sign-out':
      return `Podium signs out of ${provider} in each home it made for this login and deletes the home. A login you made yourself in the agent stays signed in.`
    case 'provider-call':
      return `Podium deletes its copy and also withdraws its access at ${provider}.`
    case 'none':
      return `Podium deletes its copy. The ${spec.title} stays valid at ${provider} until you revoke it there.`
    default:
      return 'Podium deletes its copy. Whatever exists at the provider stays valid until you revoke it there.'
  }
}

/** Credentials a harness may run on: listed, of a type its descriptor accepts. */
export function harnessChoices(
  views: readonly CredentialView[],
  accepts: readonly { type: string }[],
): CredentialView[] {
  const types = new Set(accepts.map((line) => line.type))
  return listed(views).filter((view) => isCredentialTypeId(view.type) && types.has(view.type))
}

/** Credentials a direct model call may run on: listed, of a type with a route (§9). */
export function inferenceChoices(views: readonly CredentialView[]): CredentialView[] {
  return listed(views).filter(
    (view) => isCredentialTypeId(view.type) && INFERENCE_ROUTES[view.type] !== undefined,
  )
}

/** The types a person adds by pasting the secret, in registry order. */
export function pasteTypes(): CredentialTypeId[] {
  return CREDENTIAL_TYPE_IDS.filter((type) => CREDENTIAL_TYPES[type].obtain.includes('paste'))
}

/** Where the secret to paste comes from. */
export function pasteHint(type: CredentialTypeId): string {
  if (type === 'anthropic.claude-token') {
    return 'Run claude setup-token in a terminal of your own and paste the token it prints. It lasts a year.'
  }
  return `Create a key in your ${providerName(type)} console and paste it here.`
}

/** "Name": masked identity, email or plan, whichever the record has. */
export function identityText(view: CredentialView): string | undefined {
  const { email, plan, organisation, masked } = view.identity
  return [email, plan, organisation, masked].filter(Boolean).join(' · ') || undefined
}

/**
 * The machines a credential may be sent to (§8): ones the person may run on
 * (`use: 'granted'`) and does not hold custody of. A credential reaches the
 * machines its owner looks after without being sent.
 */
export function sendableMachines(
  machines: readonly { id: string; name: string; use?: string; owned?: boolean }[],
): { id: string; name: string }[] {
  return machines
    .filter((machine) => machine.use === 'granted' && machine.owned !== true)
    .map((machine) => ({ id: machine.id, name: machine.name }))
}
