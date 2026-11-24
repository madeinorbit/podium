import type { HarnessAgent, Inventory, MachineId, UserId, WorkspaceId } from '@podium/model'
import { userCommandPrincipal } from './command-principal'
import { LlmConfigError } from './llm-error'
import {
  type AsyncMachineRowSource,
  checkMachineUse,
  ownershipSnapshotFromMachines,
} from './machine-access'
import type { UsersRepository } from './store/users'

/**
 * Which machine's Codex login the server AI uses (POD-4750).
 *
 * The server never reads a Codex login file. It names the machine from its
 * login catalog (machine inventory reports) and that machine's daemon performs
 * the Responses call, so the token never leaves its machine. This module is
 * the ONE place that choice is made — the one-shot transport and the accounts
 * hub's "Server AI uses …" row both read it, so they cannot disagree.
 */

export interface CodexLoginMachine {
  id: MachineId
  name: string
  loginConnected: boolean
  online: boolean
  /** The daemon's reported version label; null = never reported. */
  appVersion: string | null
}

/** Minimal machine projection the picker reads — satisfied by both the store
 *  records and the service listing, so the transport and the hub row share one
 *  function over whichever read they already hold. */
export interface CodexLoginMachineSource {
  readonly id: MachineId
  readonly name: string
  /** Absent (wire listing) counts as unrevoked, like explicit null. */
  readonly revokedAt?: string | null
  readonly inventory?: Inventory
  readonly appVersion?: string | null
}

/** Project machine rows onto the picker's input: unrevoked rows with the
 *  NAMED harness's login state, online reachability and daemon version.
 *
 *  The harness arrives as a value (the role's resolved harness, the row's
 *  harness) — never a literal: vendor behaviour keyed on a harness name lives
 *  in the harness package (POD-4414 §5), while the identifier itself may flow
 *  anywhere. */
export function codexLoginMachines(
  records: readonly CodexLoginMachineSource[],
  isOnline: (id: MachineId) => boolean,
  harness: HarnessAgent,
): CodexLoginMachine[] {
  return records
    .filter((record) => !record.revokedAt)
    .map((record) => ({
      id: record.id,
      name: record.name,
      loginConnected: (record.inventory?.agents ?? []).some(
        (agent) => agent.kind === harness && agent.login.state === 'in',
      ),
      online: isOnline(record.id),
      appVersion: record.appVersion ?? null,
    }))
}

export interface PickCodexMachineOpts {
  /** The fleet's default machine, when one resolves — preferred when usable. */
  defaultMachineId?: MachineId
  /** Refusal string, or undefined when the requesting user may use the machine.
   *  The SAME machine authorisation the rest of the server uses
   *  ({@link codexAuthorizerFor}): owned or granted, never another user's
   *  login spent silently. */
  authorize: (machineId: MachineId) => string | undefined
}

/**
 * Pick the machine whose Codex login the server AI runs on. Throws
 * LlmConfigError with an actionable message — never hangs, never leaks
 * another user's machine name to an unauthorized caller:
 *
 * - no usable login → generic "run `codex login`" (names nothing, since the
 *   logins that DO exist may belong to other users);
 * - the picked machine is offline → names it ("Codex login on <machine> is
 *   offline").
 *
 * Deliberately NO version gate: daemons routinely update before the server,
 * and an older daemon may already have the handler — refusing every version
 * skew would take Codex server AI down after each server-only update. A
 * daemon that truly predates the frame is covered without a gate: a new
 * enough daemon answers through the frame-guard's payload-rejection arm, and
 * anything older stays silent until the server deadline reports "no reply …
 * may be older", never "offline".
 */
export function pickCodexMachine(
  machines: readonly CodexLoginMachine[],
  opts: PickCodexMachineOpts,
): { machineId: MachineId; machineName: string } {
  const usable = machines.filter(
    (machine) => machine.loginConnected && opts.authorize(machine.id) === undefined,
  )
  if (usable.length === 0) {
    throw new LlmConfigError(
      'no connected Codex login is available to you — run `codex login` on a machine you can use, then retry.',
    )
  }
  const byName = [...usable].sort(
    (a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)),
  )
  const preferred =
    opts.defaultMachineId !== undefined
      ? usable.find((machine) => machine.id === opts.defaultMachineId)
      : undefined
  const picked = preferred ?? byName[0]!
  if (!picked.online) {
    throw new LlmConfigError(
      `Codex login on ${picked.name} is offline — bring its daemon online, then retry.`,
    )
  }
  return { machineId: picked.id, machineName: picked.name }
}

interface CodexAuthorizerDeps {
  /** The workspace whose members and machines these are. */
  workspaceId: WorkspaceId
  users: Pick<UsersRepository, 'get'>
  machines: AsyncMachineRowSource
}

/**
 * THE machine authorisation for spending a native login — the same rule
 * NativeLoginService's `authorizerFor` states (relay.ts): an admin account,
 * then the machine-use grant check over one ownership snapshot. One function
 * so the one-shot transport, the hub row and login starts cannot drift into
 * three answers about who may use which machine; only the refused ACTION's
 * noun varies (`start login` vs `use`).
 */
export async function codexAuthorizerFor(
  deps: CodexAuthorizerDeps,
  ownerUserId: UserId,
  action: 'start login' | 'use' = 'use',
): Promise<(machineId: MachineId) => string | undefined> {
  const user = await deps.users.get(ownerUserId)
  // A member logs in on their OWN machine (POD-6300): a machine's native logins
  // belong to the person who looks after it, which `NativeLoginService` checks.
  // Spending a native login for the server AI stays an admin's.
  if (!user || (action === 'use' && user.role !== 'admin'))
    return () => 'native provider login requires an admin account'
  const principal = userCommandPrincipal(deps.workspaceId, ownerUserId, user.role)
  const ownership = await ownershipSnapshotFromMachines(deps.machines)
  return (machineId) => {
    const access = checkMachineUse(principal, machineId, ownership)
    return access === 'absent'
      ? `unknown machine '${machineId}'`
      : access === 'unauthorized'
        ? `you do not have access to ${action} on this machine`
        : undefined
  }
}

/** What a daemon answers for one Codex turn on its login (`codexCompleteRequest`). */
export interface CodexTurnResult {
  ok: boolean
  text?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
  error?: string
}

/**
 * Pick the machine a login-backed direct call runs on (credential management
 * §9), from the machines that hold that login and on which the credential may
 * be used: the first online one, the fleet default first, else by name. Throws LlmConfigError with
 * an actionable message naming the credential, never another person's machine:
 * none holds it, or the one picked is offline.
 */
export function pickLoginMachine(
  machines: readonly Pick<CodexLoginMachineSource, 'id' | 'name'>[],
  opts: {
    isOnline: (id: MachineId) => boolean
    defaultMachineId?: MachineId | undefined
    /** The credential's label, for the messages. */
    label: string
  },
): { machineId: MachineId; machineName: string } {
  if (machines.length === 0) {
    throw new LlmConfigError(
      `${opts.label} is not signed in on a machine where it may be used — sign in there, then retry.`,
    )
  }
  const ordered = [...machines].sort(
    (a, b) =>
      Number(b.id === opts.defaultMachineId) - Number(a.id === opts.defaultMachineId) ||
      a.name.localeCompare(b.name) ||
      String(a.id).localeCompare(String(b.id)),
  )
  const picked = ordered.find((machine) => opts.isOnline(machine.id))
  if (!picked) {
    throw new LlmConfigError(
      `${opts.label} on ${ordered[0]!.name} is offline — bring its daemon online, then retry.`,
    )
  }
  return { machineId: picked.id, machineName: picked.name }
}
