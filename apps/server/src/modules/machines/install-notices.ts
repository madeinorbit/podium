/**
 * NOTICES ABOUT PODIUM-INSTALLED HARNESSES (POD-7281, managed installs §8).
 *
 * Podium says nothing when an update succeeds. It raises one notice per
 * harness and machine when that harness's updates have failed for three days,
 * and one per machine when the machine's install ledger was rebuilt. The
 * daemon decides nothing here: it reports `install.managed.failingSince` and
 * `install.ledgerRebuilt` in its inventory, and the server compares each new
 * report with the one before it.
 *
 *  - FAILING is a condition (`harness-install-failing`). It opens once the
 *    failing run is three days old and resolves when the run ends (a good
 *    check or an install clears `failingSince`), or the harness stops being
 *    managed. One open notice per key, so a repeated report raises nothing.
 *  - REBUILT is an event (`harness-ledger-rebuilt`), keyed by the rebuild's
 *    time: a report that names a rebuild the previous report did not name
 *    raises it once. Nothing clears it but the person reading it.
 *
 * The three days are measured when a report arrives, and only a report that
 * changed is compared. A harness whose checks keep failing reports a new
 * `lastCheckAt` with every check (six-hourly), so the notice opens at most one
 * check interval after the three days have passed.
 *
 * Notices go to the machine's custodian, the person it runs for.
 */
import type { AgentInventory, Inventory, MachineId, UserId } from '@podium/model'
import type { EmitNoticeInput } from '../notices/emit'

const DAY_MS = 86_400_000
/** Updates failing this long raise a notice (managed installs §8). */
export const INSTALL_FAILING_NOTICE_MS = 3 * DAY_MS

export const failingNoticeKey = (machineId: MachineId, kind: string): string =>
  `harness-install-failing:${machineId}:${kind}`

export const rebuiltNoticeKey = (machineId: MachineId, at: string): string =>
  `harness-ledger-rebuilt:${machineId}:${at}`

/** One notice a report raises, before it has a recipient and a machine name. */
export type InstallNoticeDraft =
  | { readonly kind: 'harness-install-failing'; readonly harness: string; readonly error?: string }
  | { readonly kind: 'harness-ledger-rebuilt'; readonly at: string; readonly reason: string }

export interface InstallNoticePlan {
  readonly emit: readonly InstallNoticeDraft[]
  readonly resolve: readonly string[]
}

type ManagedInstallWire = NonNullable<NonNullable<AgentInventory['install']>['managed']>

function managedOf(agent: AgentInventory | undefined): ManagedInstallWire | undefined {
  return agent?.install?.managed
}

function failingLong(managed: ManagedInstallWire | undefined, nowMs: number): boolean {
  if (!managed?.failingSince) return false
  const since = Date.parse(managed.failingSince)
  return Number.isFinite(since) && nowMs - since >= INSTALL_FAILING_NOTICE_MS
}

function rebuiltOf(inventory: Inventory | undefined): { at: string; reason: string } | undefined {
  for (const agent of inventory?.agents ?? []) {
    const rebuilt = agent.install?.ledgerRebuilt
    if (rebuilt) return rebuilt
  }
  return undefined
}

/** Whether a report says anything about Podium-installed harnesses. */
export function reportsManagedInstalls(inventory: Inventory | undefined): boolean {
  return inventory?.agents.some((agent) => agent.install !== undefined) ?? false
}

/**
 * What one new report changes in the inbox, compared with the report before
 * it (`previous`, absent for a machine's first report).
 */
export function planInstallNotices(
  machineId: MachineId,
  previous: Inventory | undefined,
  next: Inventory,
  nowMs: number,
): InstallNoticePlan {
  const emit: InstallNoticeDraft[] = []
  const resolve: string[] = []
  const previousByKind = new Map((previous?.agents ?? []).map((agent) => [agent.kind, agent]))
  const nextByKind = new Map(next.agents.map((agent) => [agent.kind, agent]))
  for (const kind of new Set([...previousByKind.keys(), ...nextByKind.keys()])) {
    const now = managedOf(nextByKind.get(kind))
    if (failingLong(now, nowMs)) {
      const error = now?.lastError?.message
      emit.push({ kind: 'harness-install-failing', harness: kind, ...(error ? { error } : {}) })
    } else if (failingLong(managedOf(previousByKind.get(kind)), nowMs)) {
      resolve.push(failingNoticeKey(machineId, kind))
    }
  }
  const rebuilt = rebuiltOf(next)
  if (rebuilt && rebuilt.at !== rebuiltOf(previous)?.at)
    emit.push({ kind: 'harness-ledger-rebuilt', at: rebuilt.at, reason: rebuilt.reason })
  return { emit, resolve }
}

/** The notice a draft becomes, for one machine and person. */
export function installNotice(
  draft: InstallNoticeDraft,
  machine: { id: MachineId; name: string },
  recipientUserId: UserId,
): EmitNoticeInput {
  const subject = { kind: 'machine' as const, id: machine.id }
  if (draft.kind === 'harness-install-failing')
    return {
      recipientUserId,
      kind: draft.kind,
      subject,
      title: `Updates for ${draft.harness} on ${machine.name} have failed for three days`,
      ...(draft.error ? { body: draft.error } : {}),
      dedupeKey: failingNoticeKey(machine.id, draft.harness),
    }
  return {
    recipientUserId,
    kind: draft.kind,
    subject,
    title: `Podium rebuilt its install record on ${machine.name}`,
    body: `The record was ${draft.reason === 'damaged' ? 'damaged' : 'missing'} and was rebuilt from the installed releases. Changes Podium made in your harness folders before then are no longer tracked.`,
    dedupeKey: rebuiltNoticeKey(machine.id, draft.at),
  }
}

export interface InstallNoticeDeps {
  /** The machine's name and the person it runs for (`null` for nobody). */
  machine(machineId: MachineId): Promise<{ name: string; custodian: UserId | null } | undefined>
  emit(notice: EmitNoticeInput): Promise<void>
  resolve(dedupeKey: string): Promise<void>
  now?: () => number
}

/** Apply {@link planInstallNotices} for one new report. */
export async function raiseInstallNotices(
  deps: InstallNoticeDeps,
  machineId: MachineId,
  previous: Inventory | undefined,
  next: Inventory,
): Promise<void> {
  const plan = planInstallNotices(machineId, previous, next, deps.now?.() ?? Date.now())
  for (const key of plan.resolve) await deps.resolve(key)
  if (plan.emit.length === 0) return
  const machine = await deps.machine(machineId)
  if (!machine || machine.custodian === null) return
  for (const draft of plan.emit)
    await deps.emit(installNotice(draft, { id: machineId, name: machine.name }, machine.custodian))
}
