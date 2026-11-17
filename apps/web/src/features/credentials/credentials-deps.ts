/**
 * What every part of the credentials page needs, passed as one value. A
 * takeover renders outside the page's tree, so this travels as a prop rather
 * than a React context.
 */

import type { Trpc } from '@/app/trpc'

/**
 * The credential writes (epic Task 4), each a `{ mutate }` like the tRPC
 * client's, Sign in with ChatGPT's two writes and its status read (Task 14),
 * and signing in on a machine's two writes and its status read (Task 9).
 */
export type CredentialCommands = Pick<
  Trpc['credentials'],
  | 'add'
  | 'rename'
  | 'renew'
  | 'remove'
  | 'share'
  | 'unshare'
  | 'allowMachine'
  | 'disallowMachine'
  | 'chatgptSignInStart'
  | 'chatgptSignInComplete'
  | 'chatgptSignInStatus'
  | 'signInStart'
  | 'signInCancel'
  | 'signInStatus'
>

export interface PersonChoice {
  id: string
  name: string
}

export interface MachineChoice {
  id: string
  name: string
}

export interface CredentialDeps {
  commands: CredentialCommands
  /** Read `credentials.list` again after a write. */
  reload: () => void
  /** The viewer's user id, once the roster knows it. */
  currentUserId: string | undefined
  /** Active members by name; empty when the roster could not load. */
  people: readonly PersonChoice[]
  nameOf: (userId: string) => string | undefined
  machineName: (machineId: string) => string
  /** Machines the viewer may run on and does not hold custody of (§8 "send it there"). */
  sendable: readonly MachineChoice[]
  now: () => number
}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
