/**
 * THE RELAY WRITE ADAPTER (ADR 12 D9, POD-6593): an agent's `podium <verb>`
 * write reaches its registration here, generated from the registries rather
 * than written per arm in `issues/relay-dispatch.ts`.
 *
 *  - A PLAIN registration whose declaration names the relay among its
 *    transports runs through the plain entry as the relay caller (the lock
 *    writes, the spec writes). Its handler gets the caller and the composed
 *    modules; there is no tRPC request on this transport.
 *  - A SYNC registration the relay reaches by its own name (`offer.set`,
 *    `sessions.sendText`, …) is submitted on the entry point as a relay call,
 *    the agent's `--outside-scope` riding as the envelope's confirmation.
 *
 * Exposure decides it, as on tRPC: a registration that does not name the relay
 * has no relay adapter, and the arm answers "no such procedure". The arms that
 * stay in the dispatch are the relay's reads, the family adapters that submit
 * their own registrations (issues, messages, workflows) and the relay writes
 * with gates of their own. {@link RELAY_ARMS} lists every one, with how it
 * writes; `relay-census.test.ts` fails on a relay proc it does not list.
 */

import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { IssueCaller } from '../issues/command-ctx'
import { plainCommands } from '../plain-command/commands'
import { submitPlaneCommand } from '../sessions/sync-write'

/** The relay call is not a write any registration here serves. */
export const NOT_A_RELAY_WRITE: unique symbol = Symbol('not a relay write')

export interface RelayWriteCall {
  readonly router: string
  readonly proc: string
  readonly input: unknown
  /** The relay caller, as issue authorization reads it. */
  readonly caller: IssueCaller
  readonly modules: RegistryModules
  /** Who is asking, resolved when the call is a write. */
  readonly principal: () => Promise<CommandPrincipal>
}

/** The relay calls that are plain registrations' (see the header). */
export async function relayPlainWrite(
  call: RelayWriteCall,
): Promise<unknown | typeof NOT_A_RELAY_WRITE> {
  const name = `${call.router}.${call.proc}`
  const registry = plainCommands()
  const command = registry.lookup(name)
  if (command === undefined || !command.door.exposedOn('relay')) return NOT_A_RELAY_WRITE
  const reply = await registry.run(name, {
    principal: await call.principal(),
    transport: 'relay',
    input: call.input,
    caller: call.caller,
    modules: call.modules,
  })
  if (reply.outcome === 'applied') return reply.result
  // Bad input answers with the schema's own error, as the relay always did.
  if (reply.refusal.kind === 'invalid') throw reply.refusal.error
  throw (
    command.registration.refusedOnRelay?.() ?? new Error(`${name} is not permitted for this caller`)
  )
}

/**
 * The relay calls that ARE a sync registration's, by name: submitted on the
 * entry point as `principal`, which the arm resolves (an agent's relay
 * principal, or the session plane's for a session's own commands).
 */
export async function relaySyncWrite(
  call: Pick<RelayWriteCall, 'router' | 'proc' | 'input' | 'caller' | 'modules'>,
  principal: CommandPrincipal,
): Promise<unknown> {
  return await submitPlaneCommand(call.modules, principal, 'relay', {
    command: `${call.router}.${call.proc}`,
    input: call.input,
    ...(call.caller.overrideScope === true ? { confirmed: true } : {}),
  })
}

// ---------------------------------------------------------------------------
// The relay census
// ---------------------------------------------------------------------------

/**
 * How one relay proc reaches what it does. Every proc the relay serves is
 * listed, reads included, so a new one is classified before it is served; the
 * census test (`relay-census.test.ts`) fails on one that is not.
 *
 *  - `read`: writes nothing.
 *  - `adapter`: generated here: a plain registration (`relayPlainWrite`) or a
 *    sync registration by its own name (`relaySyncWrite`).
 *  - `entry`: a hand-written arm whose write is a sync registration it submits
 *    on the entry point (`registration`), with its own gates or answer shape.
 *  - `not-synced`: its effect is on a machine, not in the database, so it has
 *    no synced write to register (`reason`).
 *  - `direct`: a synced write outside any registration, like the tRPC
 *    direct-write census (`write-routes/direct.ts`), with its owner issue.
 */
export type RelayArm =
  | { readonly kind: 'read' }
  | { readonly kind: 'adapter'; readonly via: 'plain' | 'sync' }
  | { readonly kind: 'entry'; readonly registration: string }
  | { readonly kind: 'not-synced'; readonly reason: string }
  | { readonly kind: 'direct'; readonly what: string; readonly owner: string }

const READ: RelayArm = { kind: 'read' }
const SYNC_ADAPTER: RelayArm = { kind: 'adapter', via: 'sync' }
const entry = (registration: string): RelayArm => ({ kind: 'entry', registration })

/** The procs of every relay router the allowlist names proc by proc. */
export const RELAY_ARMS: Readonly<Record<string, RelayArm>> = {
  'sync.submit': entry('*'),
  'repos.inferFromPath': READ,
  'features.state': READ,
  'quota.summary': READ,
  'sessions.sendText': SYNC_ADAPTER,
  'sessions.resumeAndSend': SYNC_ADAPTER,
  'sessions.continue': SYNC_ADAPTER,
  'sessions.status': READ,
  'sessions.read': READ,
  'sessions.title': SYNC_ADAPTER,
  // Its scope gates are the arm's; the write is `desired: stopped` as the agent.
  'sessions.stop': entry('records.session.edit'),
  // A `session.handoff` effect record, created as the agent and awaited.
  'sessions.handoff': entry('effects.create'),
  'machines.list': READ,
  'machines.listWithRepos': READ,
  'machines.reprobe': {
    kind: 'not-synced',
    reason:
      "asks a visible, usable, online machine's daemon to re-send its inventory; the report that follows is the daemon's write",
  },
  // The messages gate is the mail family's relay adapter onto the entry point.
  'messages.send': entry('mail.send'),
  'messages.inbox': entry('mail.inboxConsume'),
  'messages.show': READ,
  'messages.status': READ,
  'messages.reply': entry('mail.reply'),
  'messages.pendingReminders': entry('mail.pendingReminders'),
  'messages.spawnAgent': entry('mail.spawnAgent'),
  // A wait; its one write is the claim it retires.
  'messages.awaitAgent': entry('mail.awaitObserved'),
  'approvals.request': SYNC_ADAPTER,
  'approvals.get': READ,
  'workspace.fetch': {
    kind: 'not-synced',
    reason:
      "materializes another session's working state on the caller's machine through its daemon",
  },
  'workspace.clean': {
    kind: 'not-synced',
    reason: 'removes what fetch materialized, on the caller’s machine, through its daemon',
  },
  'offer.set': SYNC_ADAPTER,
  'offer.clear': SYNC_ADAPTER,
  // The human's own issue pin, from `podium issue update --pinned` (POD-6692).
  // Reached only inside a `sync.submit` envelope: there is no direct arm.
  'records.pin.create': entry('records.pin.create'),
  'records.pin.remove': entry('records.pin.remove'),
}

/**
 * The routers the allowlist opens whole (`null`): each proc's write is read off
 * its family's own table, which the census test checks against the registries.
 */
export const RELAY_FAMILY_ROUTERS: Readonly<Record<string, string>> = {
  issues:
    'the issue dispatcher: a synced command submits its `issues.<proc>` registration; a command that acts on machines or git creates its effect record through `effects.create` (`issues/work-effects.ts`, `issues/git-effects.ts`)',
  specs: 'writes are plain registrations (`relayPlainWrite`); reads are the service’s own',
  workflows: 'writes submit their `workflows.<proc>` registration on the entry point',
  lock: 'writes are plain registrations (`relayPlainWrite`); `status` is a read',
}
