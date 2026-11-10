/**
 * EVERY CURRENT CALLER OF THE 31 NON-SYNC COMMANDS, THROUGH THE FRONT DOOR
 * (ADR 12 D8, POD-6360).
 *
 * Moving these commands onto the plain path made their contracts' role floors
 * ENFORCED: before it, the derived families checked none of them (only
 * `setup.activate`, in its service, and the settings family's own gate). This
 * table names each caller found in the clients, with the principal it really
 * runs as, and pins whether the front door admits it. A row expected to refuse is
 * a caller the contract's floor forbids; the ones that worked before this change
 * are marked `lost`, so the change in who may do what is written down, not
 * inferred.
 *
 * Callers, from a grep of apps/web, apps/mobile, apps/desktop, apps/cli,
 * apps/daemon and packages/{client-core,runtime} (2026-11-04):
 *  - web, as the signed-in user, admin or member: Settings (accounts, security,
 *    secrets, privacy, diagnostic logging, updates), setup screens, the agent
 *    panel's "Open sign-in terminal", the log transport and perf switch traces;
 *  - mobile and the desktop webview: `logs.forward`, `logs.crash`;
 *  - first-run setup, as the bootstrap principal (the earliest admin);
 *  - the operator CLI (`podium logs level|daemon`, `podium join`, `podium setup`),
 *    on the operator's own credential;
 *  - agents and the daemon: none of the 29 today. The agent rows below pin what
 *    one would get;
 *  - `accounts.share` (POD-6360): Settings → Accounts, the owner on their own key
 *    and an admin on any key (POD-6390);
 *  - `accounts.unsend` (POD-6699): the owner taking back a sent key, or an admin
 *    taking it back for them;
 */

import type { AnyCommandContract } from '@podium/commands'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type Capability,
  firstAdminMemberId,
} from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  type CommandPrincipal,
  resolvePrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import { NativeLoginService } from '../accounts/native-login'
import { ACCOUNT_COMMANDS_TRPC } from '../accounts/registry'
import { EventBus } from '../bus'
import { coarselyPermitted, contractFrontDoor } from '../front-door'
import {
  AUTH_COMMANDS_TRPC,
  SETUP_COMMANDS_TRPC,
  TELEMETRY_COMMANDS_TRPC,
} from '../instance/registry'
import { LOGS_COMMANDS_TRPC } from '../logs/registry'
import { MODEL_COMMANDS_TRPC } from '../models/registry'
import { PERF_COMMANDS_TRPC } from '../perf/commands'
import { SETTINGS_COMMANDS_TRPC } from '../settings/registry'
import type { PlainTargetCheck } from './entry'

const CONTRACTS = new Map<string, AnyCommandContract>(
  [
    ...Object.values(ACCOUNT_COMMANDS_TRPC),
    ...Object.values(AUTH_COMMANDS_TRPC),
    ...Object.values(SETUP_COMMANDS_TRPC),
    ...Object.values(TELEMETRY_COMMANDS_TRPC),
    ...Object.values(LOGS_COMMANDS_TRPC),
    ...Object.values(MODEL_COMMANDS_TRPC),
    ...Object.values(PERF_COMMANDS_TRPC),
    ...Object.values(SETTINGS_COMMANDS_TRPC),
  ].map((c) => [c.contract.name, c.contract as AnyCommandContract]),
)

/** The commands whose table entry declares a target check (`entry.ts`, step 4). */
const TARGET_CHECKS = new Map<string, PlainTargetCheck>(
  Object.values(ACCOUNT_COMMANDS_TRPC).flatMap((c) =>
    'targetPermitted' in c && c.targetPermitted
      ? [[c.contract.name, c.targetPermitted] as const]
      : [],
  ),
)

const MEMBER = asUserId('user:caller-member')
const memberCapability: Capability = {
  role: 'worker',
  scope: { kind: 'owned', userId: MEMBER },
  actorUser: MEMBER,
  onBehalfOf: MEMBER,
}
/** The capability `SessionAuthz.capabilityForSession` mints for a relayed agent. */
const agentCapability: Capability = {
  role: 'worker',
  scope: { kind: 'subtree', rootId: asIssueId('iss_caller_table') },
  actorSessionId: asSessionId('ses_caller_table'),
  onBehalfOf: firstAdminMemberId(),
}

const PRINCIPALS = {
  /** The web app (and mobile, desktop, operator CLI) signed in as an admin. */
  admin: userCommandPrincipal(firstAdminMemberId(), 'admin'),
  /** The same apps signed in as a member: `userCommandPrincipal`'s member arm. */
  member: resolvePrincipal(memberCapability, { parentSessionOf: () => undefined }),
  /** First-run setup: `server.ts` resolves the earliest admin account. */
  bootstrap: userCommandPrincipal(firstAdminMemberId(), 'admin'),
  /** An agent session acting for an admin, as the relay presents it. */
  agent: resolvePrincipal(agentCapability, { parentSessionOf: () => undefined }),
} satisfies Record<string, CommandPrincipal>

type Who = keyof typeof PRINCIPALS
/** `ok`: admitted (role floor and, where declared, the target check). `floor`:
 *  refused, as before. `lost`: refused now, worked before. */
type Expect = 'ok' | 'floor' | 'lost'

const CALLERS: readonly {
  command: string
  who: Who
  caller: string
  expect: Expect
  /** The input the target check reads, for a row that names a target. */
  input?: Record<string, unknown>
}[] = [
  // ---- web, admin: every Settings and setup control ----
  ...[...CONTRACTS.keys()].map((command) => ({
    command,
    who: 'admin' as const,
    caller: 'web / CLI as an admin',
    expect: 'ok' as const,
  })),
  // ---- web / mobile / desktop, member ----
  { command: 'logs.forward', who: 'member', caller: 'web+mobile log transport', expect: 'ok' },
  { command: 'logs.crash', who: 'member', caller: 'web+mobile+desktop crash report', expect: 'ok' },
  { command: 'perf.report', who: 'member', caller: 'web switch traces', expect: 'ok' },
  { command: 'auth.setPassword', who: 'member', caller: 'Settings → Security', expect: 'ok' },
  { command: 'auth.setDisplayName', who: 'member', caller: 'Settings → Account', expect: 'ok' },
  { command: 'auth.setEmail', who: 'member', caller: 'Settings → Security', expect: 'ok' },
  // Hidden from members in the UI (`canManageInstance`); the service did not refuse.
  {
    command: 'auth.setLoginRequired',
    who: 'member',
    caller: 'Settings → Security (admin-only UI)',
    expect: 'lost',
  },
  // Every user manages their OWN harness accounts (user decision 2026-11-04):
  // a stored key is the caller's, and only the caller's agents use it until
  // they share it. Router-level proof that the row touched is the caller's own
  // (and that another user's key is untouched) is in family.test.ts.
  {
    command: 'accounts.connect',
    who: 'member',
    caller: 'Settings → Accounts, own key',
    expect: 'ok',
  },
  {
    command: 'accounts.disconnect',
    who: 'member',
    caller: 'Settings → Accounts, own key',
    expect: 'ok',
  },
  {
    command: 'accounts.share',
    who: 'member',
    caller: 'share own key',
    expect: 'ok',
    input: { id: 'managed:anthropic', everyone: true, users: [] },
  },
  {
    command: 'accounts.share',
    who: 'member',
    caller: "another user's key",
    expect: 'floor',
    input: { id: 'managed:anthropic', owner: 'user:caller-other', everyone: true, users: [] },
  },
  {
    command: 'accounts.share',
    who: 'admin',
    caller: "an admin, another user's key",
    expect: 'ok',
    input: { id: 'managed:anthropic', owner: 'user:caller-other', everyone: false, users: [] },
  },
  {
    command: 'accounts.unsend',
    who: 'member',
    caller: 'take back own sent key',
    expect: 'ok',
    input: { id: 'managed:anthropic', machineId: 'machine-shared' },
  },
  {
    command: 'accounts.unsend',
    who: 'member',
    caller: "take back another user's sent key",
    expect: 'floor',
    input: { id: 'managed:anthropic', owner: 'user:caller-other', machineId: 'machine-shared' },
  },
  {
    command: 'accounts.unsend',
    who: 'admin',
    caller: "take back another user's sent key",
    expect: 'ok',
    input: { id: 'managed:anthropic', owner: 'user:caller-other', machineId: 'machine-shared' },
  },
  // Every user signs in their OWN harness accounts (user decision 2026-11-04):
  // the terminal is spawned as the member, on a machine the member may use. The
  // refusals for another user's machine or running attempt are pinned below.
  {
    command: 'accounts.login',
    who: 'member',
    caller: 'Settings → Accounts, own account',
    expect: 'ok',
  },
  {
    command: 'accounts.login',
    who: 'member',
    caller: "agent panel's sign-in terminal",
    expect: 'ok',
  },
  {
    command: 'accounts.login',
    who: 'member',
    caller: 'first task activation sign-in',
    expect: 'ok',
  },
  { command: 'telemetry.set', who: 'member', caller: 'Settings → Privacy', expect: 'lost' },
  { command: 'telemetry.resetId', who: 'member', caller: 'Settings → Privacy', expect: 'lost' },
  {
    command: 'logs.setLevel',
    who: 'member',
    caller: 'Settings → Diagnostic logging',
    expect: 'lost',
  },
  { command: 'setup.setChannel', who: 'member', caller: 'Settings → Updates', expect: 'lost' },
  // Already refused for members, by the service or the settings gate:
  { command: 'setup.activate', who: 'member', caller: 'setup activation', expect: 'floor' },
  { command: 'settings.setSecret', who: 'member', caller: 'Settings → Secrets', expect: 'floor' },
  { command: 'settings.clearSecret', who: 'member', caller: 'Settings → Secrets', expect: 'floor' },
  {
    command: 'settings.secretPresence',
    who: 'member',
    caller: 'Settings → Secrets',
    expect: 'floor',
  },
  {
    command: 'settings.telegramBotPresence',
    who: 'member',
    caller: 'Settings → Notifications',
    expect: 'ok',
  },
  {
    command: 'settings.telegramDisconnect',
    who: 'member',
    caller: 'Settings → Notifications',
    expect: 'ok',
  },
  {
    command: 'settings.telegramSetupStart',
    who: 'member',
    caller: 'Settings → Notifications',
    expect: 'ok',
  },
  {
    command: 'settings.telegramSetupPoll',
    who: 'member',
    caller: 'Settings → Notifications',
    expect: 'ok',
  },
  // ---- first-run setup ----
  ...[
    'setup.complete',
    'setup.join',
    'setup.connect',
    'setup.activate',
    'auth.setPassword',
    'accounts.login',
  ].map((command) => ({
    command,
    who: 'bootstrap' as const,
    caller: 'first-run setup',
    expect: 'ok' as const,
  })),
  // ---- agents (no caller today) ----
  { command: 'logs.forward', who: 'agent', caller: 'none today', expect: 'ok' },
  { command: 'logs.crash', who: 'agent', caller: 'none today', expect: 'ok' },
  { command: 'perf.report', who: 'agent', caller: 'none today', expect: 'ok' },
  { command: 'telemetry.set', who: 'agent', caller: 'none today', expect: 'floor' },
  { command: 'telemetry.resetId', who: 'agent', caller: 'none today', expect: 'floor' },
  // An agent may not sign its human in, store, remove, share or take back a key as them:
  // refused by the target check.
  { command: 'accounts.login', who: 'agent', caller: 'none today', expect: 'floor' },
  { command: 'accounts.connect', who: 'agent', caller: 'none today', expect: 'floor' },
  { command: 'accounts.disconnect', who: 'agent', caller: 'none today', expect: 'floor' },
  {
    command: 'accounts.share',
    who: 'agent',
    caller: 'none today',
    expect: 'floor',
    input: { id: 'managed:anthropic', everyone: true, users: [] },
  },
  {
    command: 'accounts.unsend',
    who: 'agent',
    caller: 'none today',
    expect: 'floor',
    input: { id: 'managed:anthropic', machineId: 'machine-shared' },
  },
]

describe('every current caller of the 31 non-sync commands', () => {
  it('covers the 31 commands, and only them', () => {
    expect(CONTRACTS.size).toBe(31) // includes accounts.unsend; accounts.keys is a query
    // None is queued any more. The two that were moved onto synced record
    // edits on purpose:
    //  - settings.updatePersonal: records.userPreferences.edit (POD-6673);
    //  - settings.updateInstance: records.instancePreferences.edit (POD-6677).
    const queued = [...CONTRACTS.values()].filter((c) => c.delivery.class === 'offline-eligible')
    expect(queued.map((c) => c.name)).toEqual([])
    const plain = [...CONTRACTS.values()].filter((c) => c.delivery.class !== 'offline-eligible')
    expect(plain).toHaveLength(31)
    for (const row of CALLERS) expect(CONTRACTS.has(row.command), row.command).toBe(true)
  })

  it('classifies accounts.unsend as an online-sensitive credential write', () => {
    expect(CONTRACTS.get('accounts.unsend')).toMatchObject({
      visibility: 'secret',
      policy: { action: 'write', roleFloor: 'member', resource: 'secret' },
      delivery: { class: 'online-sensitive' },
    })
  })

  it.each(
    CALLERS.filter((row) => !row.command.startsWith('settings.update')),
  )('$command as $who ($caller): $expect', ({ command, who, expect: expected, input }) => {
    const contract = CONTRACTS.get(command)!
    const target = TARGET_CHECKS.get(command)
    const admitted =
      coarselyPermitted(contractFrontDoor(contract), PRINCIPALS[who], 'trpc') &&
      (target === undefined || target(PRINCIPALS[who], input ?? {}))
    expect(admitted).toBe(expected === 'ok')
  })
})

describe("a member's harness sign-in touches only their own account (POD-6360)", () => {
  const OTHER = asUserId('user:caller-other')
  const MINE = asMachineId('machine-member')
  const THEIRS = asMachineId('machine-other')

  function loginService() {
    const machine = (id: typeof MINE) => ({
      id,
      name: id,
      online: true,
      inventory: {
        os: 'linux',
        arch: 'x64',
        tools: [],
        agents: [{ kind: 'codex', installed: true, login: { state: 'out' } }],
      },
    })
    let spawned = 0
    const createSession = vi.fn(async () => ({ sessionId: asSessionId(`ses_login_${++spawned}`) }))
    // Each user may use only their own machine, as `codexAuthorizerFor` answers.
    const ownMachine: Record<string, typeof MINE> = { [MEMBER]: MINE, [OTHER]: THEIRS }
    const service = new NativeLoginService({
      bus: new EventBus(),
      machines: { listMachines: async () => [machine(MINE), machine(THEIRS)] } as never,
      sessions: { createSession } as never,
      authorizerFor: (owner) => (machineId) =>
        ownMachine[owner] === machineId
          ? undefined
          : 'you do not have access to start login on this machine',
      cwdForMachine: () => '/repo',
      custodianOf: async (machineId) => (machineId === MINE ? MEMBER : OTHER),
    })
    return { service, createSession }
  }

  it('a member signs in on their own machine, as themselves', async () => {
    const { service, createSession } = loginService()
    await expect(service.start({ harness: 'codex', ownerUserId: MEMBER })).resolves.toMatchObject({
      machineId: MINE,
    })
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: MEMBER }))
  })

  it("a member naming another user's machine is refused, and nothing is spawned", async () => {
    const { service, createSession } = loginService()
    await expect(
      service.start({ harness: 'codex', machineId: THEIRS, ownerUserId: MEMBER }),
    ).rejects.toThrow('you do not have access to start login on this machine')
    expect(createSession).not.toHaveBeenCalled()
  })

  it("a member is never handed another user's running sign-in terminal", async () => {
    const { service } = loginService()
    const theirs = await service.start({ harness: 'codex', ownerUserId: OTHER })
    const mine = await service.start({ harness: 'codex', ownerUserId: MEMBER })
    expect(mine.sessionId).not.toBe(theirs.sessionId)
    expect(mine.machineId).toBe(MINE)
    expect(service.attempt(MEMBER, 'codex')?.sessionId).toBe(mine.sessionId)
  })
})
