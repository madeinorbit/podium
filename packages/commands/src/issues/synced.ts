/**
 * THE ISSUE COMMANDS ON THE SYNC WRITE ENTRY POINT (ADR 12 D2; POD-6350,
 * POD-6413).
 *
 * One list for the server, which registers each of these on `sync.submit`, and
 * for the clients, which send them there. Every transport reaches them through
 * the entry point: the apps and the CLI on `sync.submit`, an agent's relay and
 * the in-process MCP through the issue dispatcher's adapter.
 *
 * Two of them carry operations the entry point refuses, because they do work
 * outside the database inside the request (ADR 12 D5): `create` with `startNow`
 * (the apps start a task with an `issue.start` effect record; the old route and
 * the relay start it after the create commits), and `panelApply`'s artifact
 * operations (see {@link PANEL_ARTIFACT_OPS}).
 */

import { type SyncSubmitTransport, writesThroughSubmit } from '@podium/protocol'
import type { IssueContractName } from './contracts'

/** The commands the apps queue in their outbox (POD-6350). */
export const QUEUED_ISSUE_COMMANDS = [
  'markRead',
  'markUnread',
  'setTucked',
  'update',
  'archive',
  'delete',
  'close',
  'defer',
  'undefer',
  'setLabels',
  'setPlacement',
  'restore',
] as const satisfies readonly IssueContractName[]

/** The issue structure writes sent at once (POD-6413). */
export const STRUCTURE_ISSUE_COMMANDS = [
  'create',
  'depAdd',
  'depRemove',
  'move',
  'reparent',
  'promote',
  'duplicate',
  'supersede',
  'claim',
  'setCoordinator',
  'setState',
  'setNeedsHuman',
  'clearNeedsHuman',
  'share',
  'unshare',
  'addComment',
  'applySuggestion',
  'dismissSuggestion',
  'panelApply',
  'subscriptionAdd',
  'subscriptionRemove',
  'subscriptionSetEnabled',
] as const satisfies readonly IssueContractName[]

/** Every issue command on the entry point, by its procedure name. */
export const SYNCED_ISSUE_COMMANDS = [
  ...QUEUED_ISSUE_COMMANDS,
  ...STRUCTURE_ISSUE_COMMANDS,
] as const

export type SyncedIssueCommand = (typeof SYNCED_ISSUE_COMMANDS)[number]

const SYNCED: ReadonlySet<string> = new Set(SYNCED_ISSUE_COMMANDS)

export const isSyncedIssueCommand = (proc: string): proc is SyncedIssueCommand => SYNCED.has(proc)

/**
 * `panelApply` operations that move files (a daemon read, the server's artifact
 * store). They are not written through the entry point yet; the adapters keep
 * them on the family's own path.
 */
export const PANEL_ARTIFACT_OPS: ReadonlySet<string> = new Set([
  'artifact-add',
  'artifact-upload',
  'artifact-remove',
])

/** Whether one issue command call is written through the entry point. */
export function writesThroughEntry(proc: string, input: unknown): proc is SyncedIssueCommand {
  if (!isSyncedIssueCommand(proc)) return false
  if (proc !== 'panelApply') return true
  const op = (input as { op?: unknown } | null | undefined)?.op
  return typeof op !== 'string' || !PANEL_ARTIFACT_OPS.has(op)
}

/**
 * Whether a client may send this call on `sync.submit` itself. A create that
 * starts its task may not: the entry point refuses `startNow`, and the command's
 * route creates through the entry point, then starts (the apps use an
 * `issue.start` effect record instead).
 */
export function clientSendsThroughSubmit(proc: string, input: unknown): proc is SyncedIssueCommand {
  if (!writesThroughEntry(proc, input)) return false
  return !(proc === 'create' && (input as { startNow?: unknown } | null)?.startNow === true)
}

/**
 * A client's issue procedures with the listed writes sent on `sync.submit`
 * (ADR 12 D2, POD-6413): `issueWrites(trpc).move.mutate(input)` in place of
 * `trpc.issues.move.mutate(input)`, same procedures, same types. A create that
 * starts its task keeps its route, which creates through the entry point and
 * then starts. LEGACY(remove-after: 2027-03): an older server takes each
 * command's own route.
 *
 * Beside the list rather than in client-core, so the apps, the phone and any
 * other client take it from one place with the list it reads.
 */
export function issueWrites<C extends { readonly issues: object }>(client: C): C['issues'] {
  return writesThroughSubmit(
    client as unknown as SyncSubmitTransport,
    client.issues,
    'issues',
    clientSendsThroughSubmit,
  )
}
