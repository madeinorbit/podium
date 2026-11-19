/**
 * WHICH CREDENTIALS A SESSION MAY RUN ON, AND HOW A SESSION'S READS
 * (credential management §9 "Choosing for a session").
 *
 * The same rules the server's resolver applies, in the order it applies them,
 * so the picker offers what a launch or a switch will accept: not removed, of
 * a type the harness (and its driver) accepts, reaching the machine (a login
 * signed in there; a stored secret on its owner's machines or one it was sent
 * to). A credential that needs attention is offered disabled, with why. The
 * server still decides: what a client cannot know (an unknown custodian) is
 * left to it rather than hidden.
 */

import type { CredentialId, CredentialView, EffectiveAuth } from '@podium/model'
import { typeSpecOf } from '../credential-facts'

export type CredentialKind = 'subscription' | 'api-key' | 'token' | 'own-login'

export const KIND_WORDS: Readonly<Record<CredentialKind, string>> = {
  subscription: 'Subscription',
  'api-key': 'API key',
  token: 'Token',
  'own-login': 'Its own login',
}

/** How a session spends: a subscription, a key billed per token, a token, or
 *  whatever the harness is signed in to (`null`). */
export function credentialKind(type: string | null): CredentialKind | undefined {
  if (type === null) return 'own-login'
  if (type.endsWith('.api-key')) return 'api-key'
  if (type === 'anthropic.claude-token') return 'token'
  return typeSpecOf(type) ? 'subscription' : undefined
}

/** One accepted line of a harness descriptor, as served. */
export interface AcceptLine {
  readonly type: string
  readonly drivers?: readonly string[]
}

export type CustodianOf = (machineId: string) => string | null | undefined

/** The credential can be used on that machine (§8, §10). */
export function reachesMachine(
  view: CredentialView,
  machineId: string,
  custodianOf: CustodianOf,
): boolean {
  if (typeSpecOf(view.type)?.store === 'home') {
    return view.homes.some((home) => home.machineId === machineId && home.state === 'in')
  }
  if (view.allowedMachines.some((id) => id === machineId)) return true
  const custodian = custodianOf(machineId)
  return custodian === undefined || custodian === view.ownerUserId
}

function accepted(lines: readonly AcceptLine[], type: string, driverId: string | undefined) {
  return lines.some(
    (line) =>
      line.type === type &&
      (line.drivers === undefined || driverId === undefined || line.drivers.includes(driverId)),
  )
}

export interface CredentialChoice {
  readonly view: CredentialView
  /** Why it cannot be picked now; absent when it can. */
  readonly disabled?: string
}

export function sessionCredentialChoices(i: {
  views: readonly CredentialView[]
  accepts: readonly AcceptLine[]
  machineId: string
  driverId?: string
  custodianOf: CustodianOf
}): CredentialChoice[] {
  return i.views
    .filter(
      (view) =>
        view.status !== 'revoked' &&
        accepted(i.accepts, view.type, i.driverId) &&
        reachesMachine(view, i.machineId, i.custodianOf),
    )
    .map((view) =>
      view.status === 'attention'
        ? { view, disabled: `Needs attention: ${view.statusReason ?? 'it stopped working.'}` }
        : { view },
    )
}

/** The person's default when it is offered and usable; otherwise the harness's own login. */
export function initialCredential(
  choices: readonly CredentialChoice[],
  defaultId: string | undefined,
): CredentialId | null {
  const found = choices.find((choice) => choice.view.id === defaultId && !choice.disabled)
  return found ? found.view.id : null
}

export const OTHER_MEMBERS_LABEL = 'Another member’s credential'

const KIND_OF_METHOD: Readonly<Record<EffectiveAuth['method'], CredentialKind | undefined>> = {
  subscription: 'subscription',
  'api-key': 'api-key',
  token: 'token',
  unknown: undefined,
}

/** What a session shows of its credential: the label and the kind. */
export function sessionCredentialLine(
  session: { credentialId?: string | null; effectiveAuth?: EffectiveAuth },
  view: CredentialView | undefined,
): { label: string; kind: CredentialKind | undefined } {
  if (!session.credentialId) return { label: KIND_WORDS['own-login'], kind: 'own-login' }
  if (view) return { label: view.label, kind: credentialKind(view.type) }
  const method = session.effectiveAuth?.method
  return { label: OTHER_MEMBERS_LABEL, kind: method ? KIND_OF_METHOD[method] : undefined }
}
