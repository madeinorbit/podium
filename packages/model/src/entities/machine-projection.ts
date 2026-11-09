/**
 * THE MACHINE'S SYNCED RECORDS (ADR 12 D1, design POD-5620 §1.12, POD-6644).
 *
 * Machines reached the apps by three paths that disagreed: the live
 * `machinesChanged` frame, the machine list in the `discovery.refreshRepos`
 * reply and this thin `machine` kind. They are now three synced kinds, split by
 * who may read them:
 *
 *  - `machine`: display facts, visible to every member like repo rows (POD-4974
 *    decision 1). Spec: `name` and `updateChannelOverride`, written by a
 *    manager through generic edits. Status: everything else, by the server.
 *  - `machineAccess`: one row per (member, machine) for each member who may SEE
 *    the machine (ADR 9: `see`, `use`, `manage`). It carries that member's own
 *    verdicts and the operational facts they may read; a `use`-only fact is on
 *    it only when the member holds `use`. Written only by the server.
 *  - `checkout`: one row per checkout on a machine (a registered repository
 *    root or one of its worktrees), keyed `(machine, path)`. A registered root
 *    is visible to the members who may `manage` or `use` the machine; a worktree
 *    only to those holding `use` ("what is checked out on it" is not a `see`
 *    fact). A registered root its main repository lists as a worktree is that
 *    worktree: one path, one checkout. Written only by the server, from daemon
 *    scans, and only when a worktree is created or removed or a branch is
 *    checked out.
 *
 * NOT RECORDS: whether a machine is online and since when, its presence path,
 * daemon readiness and service availability are CONDITIONS (the
 * `machine.condition` topic, read through the LiveStore), and its load is the
 * `machine.metrics` topic. A checkout's head, ahead/behind and dirty state are
 * request answers or `checkout.changed` signals (POD-6645), never record fields:
 * they move on every commit.
 */

import { z } from 'zod'
import {
  asMachineId,
  asUserId,
  type MachineId,
  MachineIdField,
  RepoIdField,
  type UserId,
  UserIdField,
} from '../ids'
import { joinKeyParts, splitKeyParts } from '../ids/keys'
import { machinePathKey } from '../machine-path'
import { AgentKind } from './agent'
import {
  type GitRepositoryWire,
  type GitWorktreeWire,
  Inventory,
  MachineComponent,
  MachineHarnessVersion,
  MachineServiceAssignment,
  MachineServiceReport,
  MachineUseDecision,
  UpdateChannel,
} from './machine'

// ---------------------------------------------------------------------------
// machine: display facts, every member
// ---------------------------------------------------------------------------

/** How a machine's reported build compares with its channel's target. */
export const MachineVersionState = z.enum(['unreported', 'current', 'behind', 'ahead'])
export type MachineVersionState = z.infer<typeof MachineVersionState>

/** Replicated display facts, visible to every member like repo rows (POD-4974
 * decision 1). Operational detail is on {@link MachineAccessWire}. */
export const MachineProjection = z.object({
  id: MachineIdField,
  /** Spec: the name a manager gave it (`records.machine.edit`). */
  name: z.string(),
  /** Status: harnesses installed on the machine whose login is out. */
  loggedOutHarnesses: z.array(AgentKind),
  /**
   * The member holding custody, `null` when nobody does (POD-6291). It decides
   * who receives the worktree paths of the tasks homed here (design §4.2), so a
   * custody change is a change of this row: the feed re-sends those tasks to
   * the people whose view moved. Optional for rows written before it existed.
   */
  custodian: UserIdField.nullable().optional(),
  // Build and update (status, POD-6644). Optional: rows written before them,
  // and a daemon that has never reported a build.
  /** Peer-asserted build label; null until the daemon reports one. */
  appVersion: z.string().nullable().optional(),
  /** The channel this machine updates from: its pin, else the fleet default. */
  updateChannel: UpdateChannel.optional(),
  /** Spec: the manager's per-machine pin, `null` for "follows the fleet default". */
  updateChannelOverride: UpdateChannel.nullable().optional(),
  /** The selected channel's advertised target label, when there is one. */
  targetVersion: z.string().nullable().optional(),
  /** Derived by the server from the build and the target; never a client's guess. */
  versionState: MachineVersionState.optional(),
  /** Whether the daemon runs an installed bundle or a source checkout. */
  installKind: z.string().nullable().optional(),
})
export type MachineProjection = z.infer<typeof MachineProjection>

// ---------------------------------------------------------------------------
// machineAccess: one member's view of one machine
// ---------------------------------------------------------------------------

const ACCESS_SEP = '\n'

/** The feed id of one member's access row for one machine. */
export function machineAccessRowId(userId: UserId, machineId: MachineId): string {
  return joinKeyParts(ACCESS_SEP, [userId, machineId])
}

/** Inverse of {@link machineAccessRowId}. Throws on a malformed id. */
export function parseMachineAccessRowId(id: string): { userId: UserId; machineId: MachineId } {
  const [user, machine] = splitKeyParts(ACCESS_SEP, id, 2) as [string, string]
  if (user === '' || machine === '') {
    throw new Error(`malformed machine access row id: ${JSON.stringify(id)}`)
  }
  return { userId: asUserId(user), machineId: asMachineId(machine) }
}

/**
 * What one member may know and do about one machine, as the server decided it
 * for them (ADR 9 machines as owned compute). Present for every member who may
 * SEE the machine; removed when they no longer may. Every verdict is the
 * member's own: two members read two rows.
 */
export const MachineAccessWire = z.object({
  userId: UserIdField,
  machineId: MachineIdField,
  // The member's verdicts (SEE)
  /** May this member place work on the machine. */
  use: MachineUseDecision,
  /** This member holds custody of it. */
  owned: z.boolean(),
  /** This member may transfer or release its custody. */
  transferable: z.boolean(),
  /** Nobody holds custody, so nobody may use it. */
  unowned: z.boolean(),
  /** This member may adopt it (unowned, and they administer the instance). */
  adoptable: z.boolean(),
  /** This member may mark it replaced by another machine. */
  supersedable: z.boolean(),
  /**
   * Which of the machine's checkouts this member may read: `all` with USE
   * (roots and worktrees), `roots` with MANAGE alone, `none` otherwise
   * (POD-6644). Server-written. On the row so that a change of reach is a
   * change of the row, which is what moves the feed's checkout edge for this
   * member. Absent from rows an older server wrote.
   */
  checkoutReach: z.enum(['all', 'roots', 'none']).optional(),
  // Identity and lifecycle (SEE)
  hostname: z.string(),
  /** Retained audit identity; a revoked machine runs nothing. */
  revokedAt: z.string().nullable().optional(),
  /** The admin-chosen replacement; never inferred from names. */
  supersededBy: MachineIdField.nullable().optional(),
  /** Whether it was paired as a Podium-managed host. Absent means yes. */
  podiumManaged: z.boolean().optional(),
  /** Whether this machine is the one the server runs on. */
  hostsServer: z.boolean().optional(),
  /**
   * Whether its daemon speaks this server's wire and offers the server-move
   * capability. Whether a move is possible NOW also needs it online, which is a
   * condition: the reader joins the two ({@link serverMoveEligibilityOf}).
   */
  serverMoveSupported: z.boolean().optional(),
  // Services and transport (SEE)
  /** The last supervisor report, kept while offline. */
  services: MachineServiceReport.optional(),
  /** The server's intent for what the machine runs. */
  serviceAssignment: MachineServiceAssignment.optional(),
  /** Desired services as a list (compatibility projection of the assignment). */
  components: z.array(MachineComponent).optional(),
  /** Capabilities offered in the daemon's last authenticated hello. */
  deliveryCaps: z.array(z.string()).optional(),
  /** Peer-asserted protocol schema digest; informational only. */
  wireSchemaDigest: z.string().nullable().optional(),
  /** When the server last accepted a build report. */
  buildReportedAt: z.string().nullable().optional(),
  /** Why the selected update authority has no trusted target right now. */
  targetUnavailableReason: z.string().nullable().optional(),
  // Execution detail (USE only: absent unless `use` is granted)
  /** Installed harnesses and their version history. */
  harnessVersions: z.array(MachineHarnessVersion).optional(),
  /** What can run there, and as whom. */
  inventory: Inventory.optional(),
})
export type MachineAccessWire = z.infer<typeof MachineAccessWire>

// ---------------------------------------------------------------------------
// checkout: one checkout on one machine
// ---------------------------------------------------------------------------

const CHECKOUT_SEP = '\n'

/** The feed id of the checkout at `path` on `machineId`. */
export function checkoutRowId(machineId: MachineId, path: string): string {
  return joinKeyParts(CHECKOUT_SEP, [machineId, path])
}

/** Inverse of {@link checkoutRowId}. Throws on a malformed id. */
export function parseCheckoutRowId(id: string): { machineId: MachineId; path: string } {
  const [machine, path] = splitKeyParts(CHECKOUT_SEP, id, 2) as [string, string]
  if (machine === '' || path === '')
    throw new Error(`malformed checkout row id: ${JSON.stringify(id)}`)
  return { machineId: asMachineId(machine), path }
}

export const CheckoutKind = z.enum(['repository', 'worktree', 'bare'])
export type CheckoutKind = z.infer<typeof CheckoutKind>

/**
 * One checkout on a machine: a registered repository root (`root === path`) or
 * a worktree of one. Written by the server from the machine's scans, only when
 * one is created or removed or a branch is checked out. No head, ahead/behind
 * or dirty state: those change on every commit.
 */
export const CheckoutWire = z.object({
  machineId: MachineIdField,
  path: z.string().min(1),
  /** The registered repository root this checkout belongs to. */
  root: z.string().min(1),
  kind: CheckoutKind,
  /** The logical repo (`repo` record), once the server knows it. */
  repoId: RepoIdField.nullable().optional(),
  /** The checked-out branch; absent when detached or not yet scanned. */
  branch: z.string().optional(),
  originUrl: z.string().optional(),
  /** Git holds a lock on this worktree. */
  locked: z.boolean().optional(),
  /** Git would prune this worktree (its directory is gone). */
  prunable: z.boolean().optional(),
})
export type CheckoutWire = z.infer<typeof CheckoutWire>

// ---------------------------------------------------------------------------
// Joins of a record with the machine's live condition
// ---------------------------------------------------------------------------

/** Whether a server move to this machine is possible now: the record's facts
 *  joined with whether it is online (a condition). */
export function serverMoveEligibilityOf(
  access: Pick<MachineAccessWire, 'hostsServer' | 'serverMoveSupported'> | undefined,
  online: boolean,
): { eligible: boolean; reason?: 'current-server' | 'offline' | 'unsupported' } {
  if (access?.hostsServer === true) return { eligible: false, reason: 'current-server' }
  if (!online) return { eligible: false, reason: 'offline' }
  if (access?.serverMoveSupported !== true) return { eligible: false, reason: 'unsupported' }
  return { eligible: true }
}

/**
 * The supervisor's last report as it stands now. A supervisor attached while
 * the daemon is not speaks for the execution plane, and what it last reported
 * as available is not available now. The record keeps the report as it came;
 * this join with the live condition is what readers show.
 */
export function effectiveServiceReport(
  report: MachineServiceReport | undefined,
  availability: { daemon: boolean; supervisor: boolean } | undefined,
): MachineServiceReport | undefined {
  if (
    report === undefined ||
    availability === undefined ||
    !availability.supervisor ||
    availability.daemon ||
    report.agentExecution.state !== 'available'
  ) {
    return report
  }
  return {
    ...report,
    agentExecution: {
      ...report.agentExecution,
      state: 'stopped',
      reason: 'agent execution plane is disconnected',
    },
  }
}

// ---------------------------------------------------------------------------
// Registered repositories, derived from checkout records
// ---------------------------------------------------------------------------

/*
 * Each machine's checkouts arrive as `checkout` records: a registered root
 * (`root === path`) or a worktree of one. The apps' repository rows (one per
 * registered root, with its worktrees) are derived from them here, in one pass
 * per new answer, and never stored: the records are the truth (POD-6644). This
 * replaced the `discovery.refreshRepos` reply the old client store kept.
 */

/** One registered repository as the data layer reads it. */
export type CheckoutRepository = GitRepositoryWire & {
  readonly machineId: NonNullable<GitRepositoryWire['machineId']>
}

/** A repository row's id: its machine and its root path. */
export function checkoutRepositoryId(repo: {
  readonly machineId?: string | null
  readonly path: string
}): string {
  return JSON.stringify([repo.machineId ?? '', repo.path])
}

const EMPTY: readonly CheckoutRepository[] = Object.freeze([])

/**
 * The registered roots among `rows`, each with its worktrees, in the rows'
 * order (machine, then path). This derivation is pure; each client pool owns
 * its memo so no answer survives into another runtime or principal.
 */
export function repositoriesFromCheckouts(
  rows: readonly CheckoutWire[],
): readonly CheckoutRepository[] {
  if (rows.length === 0) return EMPTY
  const roots = new Map<string, CheckoutRepository & { worktrees: GitWorktreeWire[] }>()
  const key = (machineId: string, path: string) => `${machineId}\n${machinePathKey(path)}`
  for (const row of rows) {
    if (machinePathKey(row.root) !== machinePathKey(row.path)) continue
    roots.set(key(row.machineId, row.path), {
      path: row.path,
      kind: row.kind,
      machineId: row.machineId,
      ...(row.repoId ? { repoId: row.repoId } : {}),
      ...(row.branch !== undefined ? { branch: row.branch } : {}),
      ...(row.originUrl !== undefined ? { originUrl: row.originUrl } : {}),
      worktrees: [],
    })
  }
  for (const row of rows) {
    if (machinePathKey(row.root) === machinePathKey(row.path)) continue
    roots.get(key(row.machineId, row.root))?.worktrees.push({
      path: row.path,
      ...(row.branch !== undefined ? { branch: row.branch } : {}),
      ...(row.locked ? { locked: true } : {}),
      ...(row.prunable ? { prunable: true } : {}),
    })
  }
  return Object.freeze([...roots.values()])
}

// ---------------------------------------------------------------------------
// What app code reads of one machine
// ---------------------------------------------------------------------------

/**
 * One machine as app code reads it: the client's machine model (its record,
 * my access row and its live condition, POD-6644), or a server listing. Only
 * the identity and `online` are always there; every other fact is absent when
 * it is not known or not mine to read.
 */
export type MachineFacts = Readonly<Pick<MachineProjection, 'id' | 'name'>> &
  Readonly<Partial<Pick<MachineProjection, 'loggedOutHarnesses'>>> &
  Readonly<Partial<Omit<import('./machine').MachineWire, 'id' | 'name' | 'online'>>> & {
    readonly online: boolean
  }
