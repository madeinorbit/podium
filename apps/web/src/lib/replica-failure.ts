/**
 * WHY THE BOOT GATE FAILED, AND WHAT TO SAY ABOUT IT.
 *
 * The gate used to report one string — "authenticated account is unavailable" —
 * for six unrelated situations, and `AppShell` printed that string as the whole
 * explanation. Half of them are not even faults: a browser with no session is a
 * sign-in, and a server still coming up clears itself.
 *
 * So the gate classifies instead of stringifying. The cause decides WHICH screen
 * the operator gets (sign-in, still-starting, or a real failure), and the copy
 * below is the sentence they are owed; the raw string survives as `detail`, for
 * whoever will file the bug [POD-1304].
 */

import type { ServerReadiness } from '@podium/model'

export type ReplicaFailure =
  /** No session on this device. Not an error — the operator has to sign in. */
  | { readonly kind: 'signed-out' }
  /** The server answered, but its data plane is still blocked. Clears itself. */
  | { readonly kind: 'server-starting'; readonly readiness: ServerReadiness }
  /** Reachable, open, ready — and no account row to attach the work to. */
  | { readonly kind: 'account-missing' }
  /** A bearer credential was offered over plain HTTP and refused. */
  | { readonly kind: 'auth-insecure' }
  /** The status route refused outright. */
  | { readonly kind: 'auth-refused'; readonly status: number }
  /** 200, but the body was not the answer — a proxy or SPA fallback replied. */
  | { readonly kind: 'auth-intercepted' }
  /** Offline, and this browser has never held a synced copy. */
  | { readonly kind: 'offline-unknown' }
  /** Offline, and more than one account has used this browser. */
  | { readonly kind: 'offline-ambiguous'; readonly count: number }
  /** The principal resolved; the browser's own database would not open. */
  | { readonly kind: 'replica-blocked' }
  /** Anything the gate could not place. */
  | { readonly kind: 'unknown' }

/**
 * The gate's error, carrying its cause.
 *
 * `message` stays the string the gate has always thrown, so a caller that only
 * logs it — or a test that asserts on it — is unaffected. The classification
 * rides alongside rather than replacing it.
 */
export class ReplicaGateError extends Error {
  readonly failure: ReplicaFailure
  constructor(message: string, failure: ReplicaFailure) {
    super(message)
    this.name = 'ReplicaGateError'
    this.failure = failure
  }
}

export function replicaFailureOf(error: unknown): ReplicaFailure {
  return error instanceof ReplicaGateError ? error.failure : { kind: 'unknown' }
}

/**
 * Classify a parsed `/auth/status` answer.
 *
 * ORDER IS THE POINT. A blocked data plane is checked BEFORE a missing session,
 * because a server that has not finished starting reports no principal for
 * everyone — including an operator who is perfectly signed in. Reading that as
 * "signed out" would hand them a password box that the readiness boundary is
 * about to refuse anyway.
 */
export function classifyAuthStatus(status: {
  userId?: unknown
  needsAuth?: unknown
  readiness?: unknown
}): { readonly principal: string } | ReplicaFailure {
  const readiness = status.readiness as ServerReadiness | undefined
  if (readiness && readiness.dataPlane === 'blocked') return { kind: 'server-starting', readiness }
  if (typeof status.userId === 'string' && status.userId.length > 0) {
    return { principal: status.userId }
  }
  if (status.needsAuth === true) return { kind: 'signed-out' }
  return { kind: 'account-missing' }
}

/** A field in the console panel: the machine's own account of what it tried. */
export interface FailureField {
  readonly label: string
  readonly value: string
  /** `command` renders with a shell prompt; `fault` renders in the alert ink. */
  readonly tone?: 'plain' | 'command' | 'fault'
}

export interface FailureCopy {
  /** Mono eyebrow above the headline — the fault's category, not a sentence. */
  readonly eyebrow: string
  /** Two short lines. Rendered with a break where the newline is. */
  readonly headline: string
  /** The sentence the operator is owed: what happened, and what would fix it. */
  readonly prose: string
  readonly fields: readonly FailureField[]
  /** Shown in the alert ink under the fields, when the screen clears itself. */
  readonly reassurance?: string
  /** True when the gate should keep re-probing behind the screen. */
  readonly selfClearing?: boolean
}

const STILL_STARTING: Record<string, { headline: string; prose: string; next: string }> = {
  setup_required: {
    headline: 'Podium has not\nbeen set up yet.',
    prose:
      'The server is running, but it has no configuration to open a board with — so it cannot say who you are. Finish setup on the host and this screen clears itself.',
    next: 'podium setup',
  },
  restart_required: {
    headline: 'Podium is running\nthe old settings.',
    prose:
      'Your setup was saved, but this server process started before it and is still running the previous configuration. Restart Podium on the host and this screen clears itself.',
    next: 'podium restart',
  },
}

/**
 * The operator-facing account of a failure.
 *
 * Every line here is addressed to a person: what Podium was doing, what stopped
 * it, and the one thing that would change the outcome. Nothing in this function
 * prints an exception — that is `detail`'s job, behind the disclosure.
 */
export function describeReplicaFailure(
  failure: ReplicaFailure,
  context: { readonly endpoint: string },
): FailureCopy {
  const target: FailureField = { label: 'Server', value: context.endpoint }
  switch (failure.kind) {
    case 'server-starting': {
      const copy = STILL_STARTING[failure.readiness.reason ?? ''] ?? {
        headline: 'Podium is still\ncoming up.',
        prose:
          'The server answered, but it has not finished starting and cannot open your board yet. This screen clears itself once it is ready.',
        next: 'podium status',
      }
      return {
        eyebrow: 'Server / starting',
        headline: copy.headline,
        prose: copy.prose,
        fields: [
          target,
          { label: 'Reported state', value: failure.readiness.state },
          { label: 'Next check', value: copy.next, tone: 'command' },
        ],
        reassurance: 'retrying automatically — this screen clears itself',
        selfClearing: true,
      }
    }
    case 'account-missing':
      return {
        eyebrow: 'Account / not found',
        headline: 'This server has no\naccount to open.',
        prose:
          'Podium reached the server and it is not asking for a password, but it has no user account to attach your work to. The likeliest cause is that it is reading a different database than the one you set up.',
        fields: [target, { label: 'Next check', value: 'podium status', tone: 'command' }],
      }
    case 'auth-insecure':
      return {
        eyebrow: 'Connection / not secure',
        headline: 'Podium will not send\nyour token in the clear.',
        prose:
          'This browser holds a bearer credential and the link to the server is plain HTTP, which anyone on the network can read. Reach this server over HTTPS, or over localhost, and the credential travels safely.',
        fields: [
          target,
          { label: 'Required', value: 'https:// or localhost' },
          { label: 'Next check', value: 'podium config get publicUrl', tone: 'command' },
        ],
      }
    case 'auth-refused':
      return {
        eyebrow: 'Account / refused',
        headline: 'The server would not\nsay who you are.',
        prose:
          'Podium asked the server to identify this browser and the request was refused. The server is reachable, so this is something it decided rather than something the network did.',
        fields: [
          target,
          { label: 'Response', value: `HTTP ${failure.status}`, tone: 'fault' },
          { label: 'Next check', value: 'podium logs --tail', tone: 'command' },
        ],
      }
    case 'auth-intercepted':
      return {
        eyebrow: 'Route / intercepted',
        headline: 'Something else\nanswered for Podium.',
        prose:
          'The address Podium asked for your account returned a web page instead of an answer. A reverse proxy, a service worker, or another server is standing in front of this one.',
        fields: [
          { label: 'Asked', value: `${context.endpoint}/auth/status` },
          { label: 'Expected', value: 'a JSON account answer' },
          { label: 'Received', value: 'a web page', tone: 'fault' },
        ],
      }
    case 'offline-unknown':
      return {
        eyebrow: 'Offline / no local copy',
        headline: 'You are offline, and\nthis browser is empty.',
        prose:
          'Podium can work from a copy of your board held in this browser, but this one has never synced a board to work from. Connect to the server once and it keeps one from then on.',
        fields: [target, { label: 'Local copy', value: 'none', tone: 'fault' }],
      }
    case 'offline-ambiguous':
      return {
        eyebrow: 'Offline / ambiguous account',
        headline: 'More than one account\nhas used this browser.',
        prose:
          'Podium keeps each account’s local copy separate, and offline it cannot ask the server which of them is yours. Guessing would show one person’s work to another, so it does not. Connect to the server once and it opens the right one.',
        fields: [
          target,
          { label: 'Local copies', value: `${failure.count} accounts`, tone: 'fault' },
        ],
      }
    case 'replica-blocked':
      return {
        eyebrow: 'Storage / blocked',
        headline: 'This browser will not\nopen Podium’s store.',
        prose:
          'Podium keeps your board in the browser’s own database, and this browser refused to open it. Private browsing, a full disk, or a blocked site-data setting will each do that; a normal window, or clearing space, usually settles it.',
        fields: [target, { label: 'Store', value: 'IndexedDB', tone: 'fault' }],
      }
    default:
      return {
        eyebrow: 'Interface / stopped',
        headline: 'Podium could not\nopen your board.',
        prose:
          'The interface stopped before it could show your work. The detail below is the exact fault, and a reload is worth trying first.',
        fields: [target],
      }
  }
}

/** True when the cause is simply "no session", which is a sign-in and not a fault. */
export function isSignedOut(failure: ReplicaFailure): boolean {
  return failure.kind === 'signed-out'
}

/** The host to print, never the whole URL — the origin is the useful half. */
export function endpointLabel(httpOrigin: string): string {
  try {
    return new URL(httpOrigin, globalThis.location?.href ?? 'http://localhost').host
  } catch {
    return httpOrigin || 'this server'
  }
}
