/**
 * EVERY CURRENT CALLER OF THE 25 NON-SYNC COMMANDS, THROUGH THE FRONT DOOR
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
 *  - agents and the daemon: none of the 25 today. The agent rows below pin what
 *    one would get.
 */

import type { AnyCommandContract } from '@podium/commands'
import {
  asIssueId,
  asSessionId,
  asUserId,
  type Capability,
  firstAdminMemberId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type CommandPrincipal,
  resolvePrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import { ACCOUNT_COMMANDS_TRPC } from '../accounts/registry'
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
/** `ok`: admitted. `floor`: refused, as before. `lost`: refused now, worked before. */
type Expect = 'ok' | 'floor' | 'lost'

const CALLERS: readonly { command: string; who: Who; caller: string; expect: Expect }[] = [
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
  { command: 'auth.setEmail', who: 'member', caller: 'Settings → Security', expect: 'ok' },
  // Hidden from members in the UI (`canManageInstance`); the service did not refuse.
  {
    command: 'auth.setLoginRequired',
    who: 'member',
    caller: 'Settings → Security (admin-only UI)',
    expect: 'lost',
  },
  // Shown to members, with nothing refusing them before:
  { command: 'accounts.connect', who: 'member', caller: 'Settings → Accounts', expect: 'lost' },
  { command: 'accounts.disconnect', who: 'member', caller: 'Settings → Accounts', expect: 'lost' },
  {
    command: 'accounts.login',
    who: 'member',
    caller: 'Settings → Accounts; agent panel sign-in terminal',
    expect: 'lost',
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
    command: 'settings.telegramSetupStart',
    who: 'member',
    caller: 'Settings → Notifications',
    expect: 'floor',
  },
  {
    command: 'settings.telegramSetupPoll',
    who: 'member',
    caller: 'Settings → Notifications',
    expect: 'floor',
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
]

describe('every current caller of the 25 non-sync commands', () => {
  it('covers the 25 commands, and only them', () => {
    expect(CONTRACTS.size).toBe(25 + 2) // + settings.updatePersonal/updateInstance, not plain
    const plain = [...CONTRACTS.values()].filter((c) => c.delivery.class !== 'offline-eligible')
    expect(plain).toHaveLength(25)
    for (const row of CALLERS) expect(CONTRACTS.has(row.command), row.command).toBe(true)
  })

  it.each(
    CALLERS.filter((row) => !row.command.startsWith('settings.update')),
  )('$command as $who ($caller): $expect', ({ command, who, expect: expected }) => {
    const contract = CONTRACTS.get(command)!
    const admitted = coarselyPermitted(contractFrontDoor(contract), PRINCIPALS[who], 'trpc')
    expect(admitted).toBe(expected === 'ok')
  })
})
