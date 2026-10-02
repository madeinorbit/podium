import type { ServerReadiness } from '@podium/model'
import { replicaNamespaceKey } from '../replica/principal-storage'

export type ReplicaFailure =
  | { readonly kind: 'boot-stalled' }
  | { readonly kind: 'sync-invalid' }
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

/** Device-neutral cause choice; each shell paints it with its own components. */
export function replicaBootCopy(failure: ReplicaFailure): {
  label: string
  headline: string
  body: string
} {
  switch (failure.kind) {
    case 'sync-invalid':
      return {
        label: 'SYNC UNREADABLE',
        headline: 'The workspace download could not be read safely.',
        body: 'Retry to download it again.',
      }
    case 'boot-stalled':
      return {
        label: 'STILL STARTING',
        headline: 'This is taking longer than it should.',
        body: 'The app is still trying to start. You can wait, or retry now.',
      }
    case 'replica-blocked':
      return {
        label: 'STORAGE UNAVAILABLE',
        headline: 'Podium could not open on-device storage.',
        body: 'Free some space or allow app storage, then retry. Your queued changes will be kept on this device until storage is available.',
      }
    case 'signed-out':
      return {
        label: 'SIGN IN REQUIRED',
        headline: 'Your session has expired.',
        body: 'Sign in again to open your workspace.',
      }
    case 'server-starting':
      return {
        label: 'SERVER STARTING',
        headline: 'The server is still starting.',
        body: 'Your workspace will be available when the server is ready. You can retry the connection.',
      }
    case 'account-missing':
      return {
        label: 'ACCOUNT UNAVAILABLE',
        headline: 'The server could not identify your account.',
        body: 'Check the server setup, then retry.',
      }
    case 'auth-insecure':
      return {
        label: 'SECURE CONNECTION REQUIRED',
        headline: 'Your token needs a secure connection.',
        body: 'Connect to the server over HTTPS, then retry.',
      }
    case 'auth-refused':
      return {
        label: 'ACCOUNT REFUSED',
        headline: 'The server refused your account request.',
        body: 'Check your server connection and sign-in, then retry.',
      }
    case 'auth-intercepted':
      return {
        label: 'UNEXPECTED RESPONSE',
        headline: 'Something else answered for Podium.',
        body: 'Check the server address and proxy configuration, then retry.',
      }
    case 'offline-unknown':
      return {
        label: 'NO LOCAL COPY',
        headline: 'There is no saved workspace on this device.',
        body: 'Connect to the server once to download your workspace.',
      }
    case 'offline-ambiguous':
      return {
        label: 'ACCOUNT UNKNOWN',
        headline: 'More than one account has used this device.',
        body: 'Connect to the server to identify the right account.',
      }
    default:
      return {
        label: 'CANNOT START',
        headline: 'Podium could not finish starting.',
        body: 'The server connection or on-device storage stopped before the app could load. Retry to reopen your workspace.',
      }
  }
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
  syncBoundaryId?: unknown
  memberId?: unknown
  needsAuth?: unknown
  readiness?: unknown
}): { readonly principal: string } | ReplicaFailure {
  if (status === null || typeof status !== 'object') return { kind: 'auth-intercepted' }
  const readiness = status.readiness as ServerReadiness | undefined
  if (readiness && readiness.dataPlane === 'blocked') return { kind: 'server-starting', readiness }
  if (
    typeof status.memberId === 'string' &&
    status.memberId.length > 0 &&
    typeof status.syncBoundaryId === 'string' &&
    status.syncBoundaryId.length > 0
  ) {
    return {
      principal: replicaNamespaceKey({
        syncBoundaryId: status.syncBoundaryId,
        memberId: status.memberId,
      }),
    }
  }
  if (status.needsAuth === true) return { kind: 'signed-out' }
  return { kind: 'account-missing' }
}
