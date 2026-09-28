import type { HarnessAgent, Inventory, MachineId, UserId } from '@podium/model'
import { userCommandPrincipal } from './command-principal'
import { LlmConfigError } from './llm-error'
import type { CodexTransport, LlmMessage, LlmTool } from './llm'
import {
  checkMachineUse,
  ownershipSnapshotFromMachines,
  type AsyncMachineRowSource,
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

/** This server's own version label — the same label daemons report. */
export function serverVersionLabel(): string {
  return process.env.PODIUM_APP_VERSION ?? 'dev'
}

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
  serverVersion: string
}

/**
 * Pick the machine whose Codex login the server AI runs on. Throws
 * LlmConfigError with an actionable message — never hangs, never leaks
 * another user's machine name to an unauthorized caller:
 *
 * - no usable login → generic "run `codex login`" (names nothing, since the
 *   logins that DO exist may belong to other users);
 * - the picked machine is offline → names it ("Codex login on <machine> is
 *   offline");
 * - its daemon predates the handler (a version label that is neither missing
 *   nor this server's own) → fast "too old" refusal instead of the full
 *   deadline wait. A missing label sends anyway; the deadline then reports
 *   "no reply … may be older", never "offline".
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
  if (picked.appVersion !== null && picked.appVersion !== opts.serverVersion) {
    throw new LlmConfigError(
      `the daemon on ${picked.name} is too old for Codex server AI — update Podium there, then retry.`,
    )
  }
  return { machineId: picked.id, machineName: picked.name }
}

interface CodexAuthorizerDeps {
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
  if (user?.role !== 'admin') return () => 'native provider login requires an admin account'
  const principal = userCommandPrincipal(ownerUserId, user.role)
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

export interface CodexTransportDeps {
  listMachines(): Promise<readonly CodexLoginMachineSource[]>
  isOnline(id: MachineId): boolean
  /** The fleet default; undefined when none resolves. */
  defaultMachineId(): Promise<MachineId | undefined>
  authorizerFor(owner: UserId): Promise<(machineId: MachineId) => string | undefined>
  /** The user whose settings name the backend — the digest reads the first
   *  admin's settings, so it spends a login that admin may use. */
  ownerUserId(): Promise<UserId>
  serverVersion: string
  codexComplete(
    machineId: MachineId,
    input: {
      model: string
      messages: LlmMessage[]
      tools: LlmTool[]
      effort: 'low' | 'medium' | 'high'
    },
  ): Promise<{ ok: boolean; text?: string; toolCalls?: { id: string; name: string; arguments: string }[]; error?: string }>
}

/**
 * Build the transport a `codex`-provider client runs on (POD-4750): pick the
 * owning machine from the login catalog — scoped to the requesting user —
 * send the turn through the daemon RPC, and return ONLY the model's reply.
 * Daemon refusals and the no-reply deadline both surface as LlmConfigError
 * with the daemon's (or deadline's) actionable text.
 */
export function createCodexTransport(deps: CodexTransportDeps): CodexTransport {
  return {
    complete: async (model, messages, tools, effort, harness) => {
      const authorize = await deps.authorizerFor(await deps.ownerUserId())
      const picked = pickCodexMachine(
        codexLoginMachines(await deps.listMachines(), deps.isOnline, harness),
        {
          defaultMachineId: await deps.defaultMachineId(),
          authorize,
          serverVersion: deps.serverVersion,
        },
      )
      const result = await deps.codexComplete(picked.machineId, { model, messages, tools, effort })
      if (!result.ok) throw new LlmConfigError(result.error ?? 'Codex turn failed.')
      return { text: result.text ?? '', toolCalls: result.toolCalls ?? [] }
    },
  }
}
