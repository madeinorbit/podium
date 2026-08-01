/**
 * THE TWELVE FLEET COMMAND CONTRACTS (POD-384; ADR 3 D1, POD-311's L1/L3 split).
 *
 * `machines.rename · machines.share · machines.unshare · machines.revoke · machines.pairingCode ·
 *  repos.add · repos.addMany · repos.remove · repos.setPrefix ·
 *  discovery.refreshRepos · discovery.scanFolder · discovery.scanMachine`
 *
 * L1 DATA ONLY. Every handler lives with the fleet feature in `apps/server`
 * (`modules/fleet/handlers.ts`) and is joined to its contract at
 * `modules/fleet/registry.ts`; `modules/fleet/trpc.ts` derives the wire surface
 * from the joined table and `router.ts` spreads it.
 *
 * ---------------------------------------------------------------------------
 * ONE VISIBILITY CLASS, READ OFF ADR 1's MATRIX AND NOT CHOSEN HERE
 * ---------------------------------------------------------------------------
 *
 * Eleven of the twelve write (or execute against) `owned-compute`, and the remaining one
 * writes a `secret`. Neither is a judgement call made in this file:
 *
 *  - `ROW.machine` — "Machine (fleet row / `machines`)" — is `owned-compute`,
 *    `offline: 'online-only'`.
 *  - `ROW.repoPrefix` — "Repo / prefix (`repos`, `repo_prefixes`)" — is
 *    `owned-compute` and inherits its owner FROM the machine (Amendment 1
 *    D13.5: per-machine facts carry no owner of their own).
 *  - `ROW.pairingToken` — "Pairing token / client session token" — is `secret`,
 *    `offline: 'never-enqueue'`, `secret: 'secret-value'`.
 *
 * `contracts.test.ts` asserts each of those three against `visibilityClassOf()`
 * per row, so a reclassification by POD-1071 turns these contracts RED instead
 * of leaving them quietly disagreeing with the row they mirror.
 *
 * THE CLASS THAT WOULD HAVE BEEN WRONG IS `personal`. A repo registration, a
 * prefix, a discovered worktree and a host's directory listing are all
 * per-machine FACTS, and ADR 9 D3 rule 3 gives them the machine's scoping
 * rather than their own. Keying them to the caller would make one person's
 * registered repo invisible to the machine's owner — and would put a
 * code-execution boundary (D6 M2) behind a privacy toggle.
 *
 * ---------------------------------------------------------------------------
 * `manage` VERSUS `use`, DECIDED PER COMMAND AND NOT PER ROUTER
 * ---------------------------------------------------------------------------
 *
 * ADR 9 D6 M1's table is the authority: `manage` is "rename, unpair, rotate
 * pairing token, remove from fleet"; `use` is "spawn, reattach, attach a PTY,
 * execute harness commands, read/write files, take a worktree".
 *
 *  - `machines.rename` / `machines.revoke` are M1's `manage` verbatim.
 *  - The four `repos.*` writes are fleet INVENTORY edits: which paths this
 *    machine has registered. Nothing executes on the target machine —
 *    `RepoRegistry.add`'s origin capture reads `<path>/.git` on the SERVER's
 *    own disk, which is why it silently yields nothing for a remote path — so
 *    `use` would overstate the act and would read as if registering a path were
 *    the dangerous one. `manage`.
 *  - The three `discovery.*` commands DO place work on the target machine: each
 *    sends a `scanRepos` / discovery request to THAT machine's daemon, which
 *    walks its filesystem. That is M1's "read/write files" and M2's
 *    code-execution boundary. `use` — with everything `use` drags in: they may
 *    not be `offline-eligible` (Amendment 1 D18.3) and they must keep
 *    unauthorized distinguishable from unreachable (M5).
 *
 * The precedent for splitting these is `workflows.profileSave`, which names a
 * machine and declares NO `machineVerb` because it pins compute rather than
 * running on it. Same question, asked twelve times.
 *
 * ---------------------------------------------------------------------------
 * THE ROLE FLOOR, AND THE ONE PLACE ADR 9 READS TWO WAYS
 * ---------------------------------------------------------------------------
 *
 * ADR 9 D1.4 says the account role "is what makes an action *admin-grade*
 * (secrets per ADR 1 D6, deployment-substrate `manage` per D3, machine `manage`
 * per D6)". ADR 9 D6 M1 says the default holder of machine `manage` is "Owner +
 * admins". Those disagree about a MEMBER who owns the machine.
 *
 * Resolved by what `roleFloor` IS: per `contract.ts`, "a floor on which commands
 * you may ATTEMPT; it never decides which ROWS you may touch." A floor of
 * `admin` on `machines.rename` makes D6 M1's owner column unreachable — the
 * owning member is refused before any row is read. A floor of `member` keeps
 * BOTH readings satisfiable: the floor admits the owner, and the per-row
 * owner/grant check (POD-1079) is what refuses a member who is neither owner nor
 * admin. So machine `manage` and the repo/discovery family are `member`.
 *
 * `machines.pairingCode` is the exception, and the asymmetry is the argument
 * rather than an inconsistency: it mints a credential for a machine that does
 * not exist yet, so there is NO row to own and no ownership check that could
 * ever admit a member. The floor is the only gate there is, and ADR 9 D3 rule 5
 * ("secret management becomes admin-grade once there is more than one human")
 * plus D1.4's `secrets` clause decide it. `admin`.
 *
 * DECLARED, NOT ENFORCED — said plainly because POD-389 established the habit.
 * Nothing in this migration reads `roleFloor`, `machineVerb` or `confirmation`
 * at runtime; the shipped gates are unchanged (the hub role gate below is the
 * one exception and it IS enforced). POD-1079 owns machine ownership and the
 * see/use/manage grants; these contracts are what it will enforce against.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE IS DEFAULT-CLOSED AND MEASURED
 * ---------------------------------------------------------------------------
 *
 * Every one of the twelve declares `['trpc']` and nothing else, because tRPC is
 * what serves them: `RELAY_ALLOWED` (`modules/issues/relay-gate.ts`) grants the
 * `repos` router exactly `inferFromPath` — a QUERY — and does not list
 * `machines` or `discovery` at all, so no relayed agent can reach any of these;
 * no CLI verb and no MCP tool reaches them either. Naming `relay` would not open
 * them, but it would make the field a decoration, and ADR 3 D3's whole content
 * is that a transport is served because a contract NAMES it.
 */

import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  CommandPolicy,
  DeliveryPolicy,
  RedactionPolicy,
  TransportTag,
} from '../contract'

// ---------------------------------------------------------------------------
// The fleet-specific column: which SERVER ROLE serves the command
// ---------------------------------------------------------------------------

/**
 * WHICH ROLE OF THE SERVER (`roles.ts`) SERVES THIS COMMAND — the fleet family's
 * one extra column, in the same shape `WorkflowCommandContract` uses for its
 * `advance` declaration.
 *
 * This is NOT a principal fact and does not belong in `policy`: `policy` answers
 * "may this caller do this", and this answers "does this process serve this
 * surface at all". A node that does not run the hub role does not have a fleet
 * admin surface to be refused FROM — the procedure is absent, and the shipped
 * behaviour is `NOT_FOUND` (HTTP 404) rather than `FORBIDDEN`, deliberately
 * (`hubRoleGuard`, `router.ts`). Preserving that shape is this issue's
 * acceptance criterion, so it is declared here and DERIVED at the transport
 * rather than restated as a middleware someone must remember to attach.
 *
 * REQUIRED and total, for `contract.ts`'s reason: `core` must be WRITTEN, never
 * reached by leaving the field off, or "I forgot" and "this is core" look alike.
 */
export type FleetServerRole = 'core' | 'hub'

export interface FleetCommandContract<In extends z.ZodTypeAny = z.ZodTypeAny, Out = unknown>
  extends CommandContract<In, Out> {
  readonly policy: CommandPolicy & { readonly machineSharingAuthority?: 'owner-only' }
  readonly serverRole: FleetServerRole
}

// ---------------------------------------------------------------------------
// Shared input pieces — the SAME schemas the shipped surface validates with, so
// the cutover is a move and not a re-specification.
// ---------------------------------------------------------------------------

/** The optional machine selector every repo and discovery command carries.
 *  Absent means "the default machine" — resolved in the handler, exactly as the
 *  shipped procedures resolve it (`machines.defaultMachine()`). */
const machineSelector = z.string().optional()

export const machineRenameInput = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
})

export const machineShareInput = z.object({
  id: z.string(),
  grantee: z.string().min(1),
  verb: z.enum(['see', 'use', 'manage']),
})

export const machineUnshareInput = machineShareInput

export const machineRevokeInput = z.object({ id: z.string() })

export const machinePairingCodeInput = z
  .object({ copyAgentCredentials: z.boolean().optional() })
  .optional()

export const repoAddInput = z.object({
  path: z.string(),
  machineId: machineSelector,
  /** Optional nice-id prefix override (#474); derived from the repo name when absent. */
  prefix: z.string().optional(),
})

export const repoAddManyInput = z.object({
  paths: z.array(z.string()),
  machineId: machineSelector,
})

export const repoRemoveInput = z.object({ path: z.string(), machineId: machineSelector })

export const repoSetPrefixInput = z.object({
  path: z.string(),
  prefix: z.string(),
  machineId: machineSelector,
})

/** The shipped `discovery.refreshRepos` takes no input at all. `z.void()` is how
 *  that is SAID rather than left off — the contract must carry a schema, and a
 *  permissive one would accept a payload the command has never read. */
export const discoveryRefreshReposInput = z.void()

export const discoveryScanFolderInput = z.object({
  path: z.string(),
  maxDepth: z.number().int().positive().optional(),
  machineId: machineSelector,
})

export const discoveryScanMachineInput = z.object({
  machineId: z.string(),
  deep: z.boolean().optional(),
  /** The folder the user is browsing — scanned as an extra root ("scan here",
   *  POD-855) [spec:SP-5eb6] alongside the always-on known-repo tiers. */
  atPath: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Shared policy cells, so a repeated rule cannot drift between contracts.
// ---------------------------------------------------------------------------

/** See the header: what is WIRED, measured against `RELAY_ALLOWED` and the CLI
 *  table, not what a class would have permitted. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/**
 * ADR 3 D8 / Amendment 1 D16 and ADR 9 D5 A1 — one sentence on every contract
 * because it is one rule. The half that is easy to leave out is what the SENDER
 * is told: a delegation that no longer resolves must deny the way an unknown id
 * denies, or the refusal itself reports that the machine exists.
 */
const REAUTHORIZATION =
  'Re-authorized at every apply against the delegation resolved LIVE (ADR 9 D5 A1): the agent’s own ' +
  'scope intersected with its human’s CURRENT rights, never a capability frozen at spawn. A machine ' +
  'grant revoked between enqueue and apply denies the apply, and — outside the `use` family below — ' +
  'the denial is byte-identical to an unknown machine id (Amendment 1 D20.2) so the refusal is not ' +
  'itself an existence oracle.'

/**
 * The whole family is `online-only`, and it is a MEASUREMENT of ADR 1's matrix
 * rather than a preference: `ROW.machine` and `ROW.repoPrefix` both declare
 * `offline: 'online-only'`.
 *
 * The reasoning underneath it is worth keeping because it is not the usual
 * "someone else might edit this too": these commands are addressed to a SERVER
 * ROLE and to a live daemon. A queued rename replayed against a process that
 * does not run the hub role does not conflict — the surface is not there at all
 * (`serverRole`), and the reply would be a 404 for a command the sender believed
 * had been accepted.
 */
const FLEET_DELIVERY: DeliveryPolicy = {
  class: 'online-only',
  outboxReconciliation:
    'Never enters the client Outbox. ADR 1’s matrix declares `offline: "online-only"` for both the ' +
    'machine row and the repo/prefix row, and the addressing is why: a fleet write is addressed to a ' +
    'server ROLE (see `serverRole`) and, for the discovery family, to a live daemon. Replaying one ' +
    'from a queue would apply an instruction about a machine that may have been revoked, or send it ' +
    'to a process whose fleet surface does not exist. ADR 3 D3 rule 2 keeps this honest at the other ' +
    'end: nothing here names `outbox`, and it could not.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * The pairing mint's own class. `secret` visibility FORCES `online-sensitive`
 * (ADR 3 D4 rule 1, checked by `classificationErrors`), and ADR 1's matrix says
 * the same thing in its own vocabulary: `ROW.pairingToken` is
 * `offline: 'never-enqueue'`, `replication: 'none'`.
 */
const PAIRING_DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'Never queued, never replicated, never persisted client-side (ADR 1 D6, ADR 9 D3 rule 5). The ' +
    'mint RETURNS credential material; a queue entry for it would be a bearer token at rest on a ' +
    'client, and a replay would mint a SECOND live code nobody asked for. `ROW.pairingToken` declares ' +
    '`never-enqueue` and this is that row’s command.',
  applyTimeReauthorization: REAUTHORIZATION,
}

/**
 * ADR 9 D5 A3 / Amendment 1 D17. Both halves from the transport principal and
 * never from payload — which for this family is load-bearing rather than
 * ceremonial: ADR 9 D6 M3 makes the human a pairing is performed ON BEHALF OF
 * the future OWNER of the machine that joins, so an attribution pair read from
 * the payload would let the caller choose who owns the compute.
 */
const FLEET_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Stamped from the transport principal on both halves. ADR 9 D6 M3 — "pairing runs from that ' +
    'person’s laptop with their join code, so they are the owner" — makes the on-behalf-of human of ' +
    'a mint the future owner of the machine that joins, and ADR 1’s machine row records the pairer. ' +
    'A payload-supplied pair would therefore be a way to assign someone else’s compute to yourself; ' +
    'ADR 3 D7 already declares payload identity inert and this family is the sharpest case for it.',
}

/** Nothing in the machine/repo family carries sensitive input or output. Stated
 *  once, reviewed once — and NOT reused for the pairing mint, which does. */
const PUBLIC_REDACTION: RedactionPolicy = {
  reviewed: true,
  inputPaths: [],
  outputPaths: [],
  note:
    'Public fields only. `ROW.machine` declares `secret: "public"` for id, name, hostname, lastSeen ' +
    'and inventory, and `ROW.repoPrefix` the same for paths and prefixes. A repo PATH is a filesystem ' +
    'fact about a machine, disclosed to whoever may `see` that machine (ADR 9 D3 rule 3) — it is ' +
    'scoped by the machine, not redacted. The pairing token is a different row and has its own cell.',
}

/** ADR 9 D5 A4 with the per-machine-fact refinement, shared by the four writes
 *  that register rows keyed to a machine. */
const REPO_ROW_OWNERSHIP = (note: string) =>
  ({
    creates: ['repo registration (`repos` row)', 'repo prefix (`repo_prefixes` row)'],
    owner: 'on-behalf-of-human',
    visibility: 'owned-compute',
    inheritanceOnCreate: 'parent',
    note,
  }) as const

/** The parent-inheritance sentence, which is the whole content of ADR 1
 *  Amendment 1 D13.5 for this family and is identical on all four. */
const REPO_ROW_NOTE =
  'INHERITS the machine, and does not carry an owner of its own — ADR 1 Amendment 1 D13.5, which ' +
  '`ROW.repoPrefix` states as `owner: { kind: "inherits", from: ROW.machine }`. Owning a repo row ' +
  'separately from its machine would produce incoherent states (a repo visible to someone with no ' +
  '`see` on the machine it lives on), so `inheritanceOnCreate: "parent"` is the operative field here ' +
  'and ADR 9 D5 A4’s on-behalf-of default is what the parent chain bottoms out in.'

// ---------------------------------------------------------------------------
// machines.* — the hub-role fleet admin surface
// ---------------------------------------------------------------------------

/**
 * Rename a machine. ADR 9 D6 M1's `manage` verb, first entry in its list.
 *
 * `visibility: 'owned-compute'` and `policy.resource: 'machine'` are coupled by
 * `classificationErrors` and both are true here for the same reason: what it
 * writes IS the machine row, and there is nothing else its grants could hang on.
 */
export const machineRenameContract = {
  name: 'machines.rename',
  version: 1,
  visibility: 'owned-compute',
  input: machineRenameInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'none',
    rationale:
      'ADR 9 D6 M1 lists "rename" as the first `manage` act, held by "Owner + admins". The floor is ' +
      '`member` so the OWNER can reach it (see the header on D1.4 vs D6 M1); which rows a member may ' +
      'touch is the per-machine owner/grant check POD-1079 lands, not a role question. `manage` is ' +
      'not `use`: renaming writes a server-held row and runs nothing on the machine, so it stays ' +
      'available while the machine is offline.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: {
    creates: [],
    note: 'Creates nothing: the machine row exists (the pair handshake created it) and this edits its name.',
  },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A machine the caller cannot `see` fails exactly as an unknown id does (Amendment 1 D20.2). M5’s ' +
      'unauthorized-versus-unreachable carve-out deliberately does NOT apply: it exists for PLACEMENT, ' +
      'where "denied" and "offline" otherwise produce the same empty machine list. A rename does not ' +
      'reach the machine at all, so there is no unreachable state to distinguish and reporting one ' +
      'would leak liveness about a row the caller may not see.',
  },
  serverRole: 'hub',
  cli: { summary: 'Rename a machine in the fleet' },
} as const satisfies FleetCommandContract<typeof machineRenameInput>

/**
 * Share one machine verb. The target row gate requires `manage`, then the
 * fleet-specific authority cell narrows that to the direct owner: a `manage`
 * grantee may administer the machine but may not widen its audience.
 */
export const machineShareContract = {
  name: 'machines.share',
  version: 1,
  visibility: 'owned-compute',
  input: machineShareInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    machineSharingAuthority: 'owner-only',
    confirmation: 'none',
    rationale:
      'Sharing widens who may see, use, or manage someone’s compute. The member floor keeps the owner reachable, the manage check hides invisible rows, and owner-only authority prevents a manage grantee or instance admin from re-delegating another person’s machine.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: {
    creates: ['machine grant edge'],
    owner: 'on-behalf-of-human',
    visibility: 'owned-compute',
    inheritanceOnCreate: 'parent',
    note: 'The edge is subordinate to the machine and records the machine owner as grantor.',
  },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'An invisible machine and an unknown id share one refusal; a visible non-owner is told sharing is owner-only.',
  },
  serverRole: 'hub',
  cli: { summary: 'Share machine access with a user' },
} as const satisfies FleetCommandContract<typeof machineShareInput>

/** Revoke exactly one machine grant. The same owner-only authority applies. */
export const machineUnshareContract = {
  name: 'machines.unshare',
  version: 1,
  visibility: 'owned-compute',
  input: machineUnshareInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    machineSharingAuthority: 'owner-only',
    confirmation: 'none',
    rationale:
      'Revocation changes the machine audience and is reserved to the direct owner for the same reason as sharing; a delegated manage grant is not authority to rewrite delegation.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: { creates: [], note: 'Removes one machine grant edge; creates nothing.' },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'The same visibility and owner-only refusal shape as machines.share.',
  },
  serverRole: 'hub',
  cli: { summary: 'Remove a user’s machine access' },
} as const satisfies FleetCommandContract<typeof machineUnshareInput>

/**
 * Remove a machine from the fleet. M1's `manage` again ("unpair", "remove from
 * fleet"), and the one command in the family that is destructive.
 */
export const machineRevokeContract = {
  name: 'machines.revoke',
  version: 1,
  visibility: 'owned-compute',
  input: machineRevokeInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'confirm',
    rationale:
      'ADR 9 D6 M1 `manage` — "unpair … remove from fleet". `confirm` because it is the destructive ' +
      'member of the family: ADR 1’s machine row is `tombstone: "soft-delete"` and revoking rotates ' +
      'the secret, so the fleet identity survives — but every session, repo registration and worktree ' +
      'that inherits this machine’s scoping goes with it, which is not recoverable by re-pairing.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: { creates: [], note: 'Removes a machine row; creates nothing.' },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'Same as `machines.rename`: D20.2 applies and M5’s placement carve-out does not — revoking never reaches the machine.',
  },
  serverRole: 'hub',
  cli: { summary: 'Remove a machine from the fleet' },
} as const satisfies FleetCommandContract<typeof machineRevokeInput>

/**
 * Mint a short-lived pairing code — THE ONE CONTRACT IN THIS FAMILY THAT IS NOT
 * `owned-compute`, and the classification the brief flagged as costly to guess.
 *
 * What it WRITES is a pairing token preimage. ADR 9 D3's `secrets` row names
 * "pairing token preimages" in as many words, and ADR 1's matrix carries it as
 * `ROW.pairingToken`: `visibility: 'secret'`, `secret: 'secret-value'`,
 * `replication: 'none'`, `offline: 'never-enqueue'`, `owner: { kind: 'none',
 * reason: 'secret' }`. So `visibility: 'secret'` — which FORCES
 * `online-sensitive` through `classificationErrors`, and the matrix's
 * `never-enqueue` says the same thing from the other side.
 *
 * IT IS NOT `owned-compute`, even though the code's PURPOSE is admitting a
 * machine, and the distinction is POD-731's in mirror image: that issue declined
 * `secret` for a row carrying `secret-presence`, because "is it paired?" is a
 * different column from the token. Here the command writes the token itself, and
 * classifying it as owned compute would put credential material in a class whose
 * whole content is that it is grantable and replicated to grantees.
 *
 * `policy.resource` is `secret` and NOT `machine`, which is why this contract
 * carries no `machineVerb`: there is no machine yet. The row this mint creates
 * belongs to whatever machine later presents the code, and admitting it is the
 * `pair` handshake's act (`hub/pairing.ts`), not this command's.
 */
export const machinePairingCodeContract = {
  name: 'machines.pairingCode',
  version: 1,
  visibility: 'secret',
  input: machinePairingCodeInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'Mints credential material that admits arbitrary compute to this instance. ADR 9 D3 rule 5 — ' +
      '"secret management becomes admin-grade once there is more than one human" — and D1.4’s ' +
      '`secrets` clause set the floor, and unlike machine `manage` there is no owner column that ' +
      'could admit a member instead: the machine does not exist yet, so the role floor is the only ' +
      'gate that exists. Recorded as a FORK: ADR 9 D6 M3 ("pairing runs from that person’s laptop") ' +
      'reads as self-service, which would argue `member`. The admin floor is the default-closed side ' +
      'of it and matches the shipped surface (hub role only, Settings → Machines). Nothing enforces ' +
      'the floor today; POD-1079 owns that.',
  },
  exposure: SERVED_ON,
  delivery: PAIRING_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: ['code', 'joinCommand'],
    note:
      'THE OUTPUT IS THE SECRET. `code` is the bearer credential and `joinCommand` embeds it verbatim ' +
      '(`buildJoinCommand`), so redacting one and not the other would be theatre. They are returned to ' +
      'the minting principal — that is the command’s only purpose — and must not be logged, echoed ' +
      'into an event, persisted client-side, or included in any error. `copyAgentCredentials` is a ' +
      'boolean intent flag and carries no material.',
  },
  ownership: {
    creates: [],
    note:
      'Deliberately EMPTY, and the emptiness is a decision. The pairing token it mints is `ROW.pairingToken`, ' +
      'whose owner ADR 1 records as `{ kind: "none", reason: "secret" }` with `inheritanceOnCreate: ' +
      '"not-applicable"` — a secret has no owner and no grants to inherit (D15). Listing it under `creates` ' +
      'would force this contract to declare `owner: "on-behalf-of-human"` for a row the matrix says has none, ' +
      'which is exactly the well-typed lie POD-1075 refused. The MACHINE that eventually joins does get an ' +
      'owner — the pairer, ADR 9 D6 M3 — but it is created by the `pair` handshake, not by this command.',
  },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note: 'Takes no target id: the mint is addressed to this server, and its only input is a boolean intent flag. There is nothing an error could disclose the existence of.',
  },
  serverRole: 'hub',
  cli: { summary: 'Mint a pairing code for a new machine' },
} as const satisfies FleetCommandContract<typeof machinePairingCodeInput>

// ---------------------------------------------------------------------------
// repos.* — per-machine facts, inheriting the machine's scoping
// ---------------------------------------------------------------------------

export const repoAddContract = {
  name: 'repos.add',
  version: 1,
  visibility: 'owned-compute',
  input: repoAddInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'none',
    rationale:
      'Registers a path against a machine. `resource: "machine"` because ADR 1 Amendment 1 D13.5 gives ' +
      'the repo row no owner of its own — the machine’s grants are the only ones it has, and ' +
      '`classificationErrors` enforces that coupling from the `owned-compute` side. `manage` rather ' +
      'than `use`: this edits the machine’s inventory and executes nothing on it (the origin capture ' +
      'reads `<path>/.git` on the SERVER’s disk, which is why a remote path simply yields no origin).',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: REPO_ROW_OWNERSHIP(REPO_ROW_NOTE),
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'The caller-supplied id is `machineId`. A machine outside the caller’s `see` set fails as a ' +
      'nonexistent one (D20.2). M5’s carve-out does not apply: registering a path never contacts the ' +
      'machine, so "unreachable" is not a state this command can be in. Note that the PATH is not a ' +
      'target id in D20’s sense — an unregistered path is not a hidden entity — and validation ' +
      'failures (empty, non-absolute, duplicate prefix) surface as BAD_REQUEST exactly as they ship.',
  },
  serverRole: 'core',
  cli: { summary: 'Register a repository path on a machine' },
} as const satisfies FleetCommandContract<typeof repoAddInput>

/**
 * The scan-and-select flow's batch write. Each path is added independently so
 * one bad entry does not drop the rest, and the failures come BACK rather than
 * being swallowed — a shipped behaviour this migration preserves exactly,
 * because the selection screen renders them.
 */
export const repoAddManyContract = {
  name: 'repos.addMany',
  version: 1,
  visibility: 'owned-compute',
  input: repoAddManyInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'none',
    rationale:
      'Identical to `repos.add` in every policy dimension — it IS `repos.add` over a list. Kept as a ' +
      'separate command rather than folded in because its RESULT shape differs (it reports per-path ' +
      'failures instead of throwing on the first one), and collapsing two commands whose failure ' +
      'semantics differ is how a batch write silently becomes all-or-nothing.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: REPO_ROW_OWNERSHIP(REPO_ROW_NOTE),
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'As `repos.add`. Per-path failures are RETURNED (`failed[]`) rather than thrown; they describe paths the caller supplied, never entities it may not see.',
  },
  serverRole: 'core',
  cli: { summary: 'Register several repository paths at once' },
} as const satisfies FleetCommandContract<typeof repoAddManyInput>

export const repoRemoveContract = {
  name: 'repos.remove',
  version: 1,
  visibility: 'owned-compute',
  input: repoRemoveInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'confirm',
    rationale:
      'Deregisters a path. `confirm` because ADR 1’s repo row is `tombstone: "remove"` — a hard drop, ' +
      'not a soft one — and the nice-id prefix goes with it, so previously written refs stop ' +
      'resolving. Nothing on the machine’s disk is touched, which is why this is `manage` and not ' +
      '`use`, and why the act is recoverable by re-registering even though the row is not.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: { creates: [], note: 'Removes a repo row; creates nothing.' },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'As `repos.add`: `machineId` follows D20.2, and removing never contacts the machine so M5 has no unreachable state to report.',
  },
  serverRole: 'core',
  cli: { summary: 'Deregister a repository path' },
} as const satisfies FleetCommandContract<typeof repoRemoveInput>

export const repoSetPrefixContract = {
  name: 'repos.setPrefix',
  version: 1,
  visibility: 'owned-compute',
  input: repoSetPrefixInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'manage',
    confirmation: 'none',
    rationale:
      'Changes a repo’s human-facing nice-id prefix (#474). The prefix lives on `ROW.repoPrefix` — the ' +
      'same `owned-compute` row as the registration, `conflict: "exp-rev"` on a prefix rename — so it ' +
      'authorizes against the machine like its neighbours. Validation (`^[A-Z]{2,5}$`, server-wide ' +
      'uniqueness) stays in the STORE, where it already is, and surfaces as BAD_REQUEST.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: { creates: [], note: 'Edits an existing prefix row; the registration created it.' },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note: 'As `repos.add`. A prefix COLLISION is reported as a collision — server-wide uniqueness is a stated property of the namespace, so the refusal discloses nothing D20.2 protects.',
  },
  serverRole: 'core',
  cli: { summary: 'Set a repository’s nice-id prefix' },
} as const satisfies FleetCommandContract<typeof repoSetPrefixInput>

// ---------------------------------------------------------------------------
// discovery.* — the `use` family: work placed on someone else's hardware
// ---------------------------------------------------------------------------

/**
 * The three discovery commands share every cell that follows from `use`, and the
 * cells are written here ONCE because the reasoning is literally the same
 * sentence three times — `contracts.test.ts` asserts the partition (exactly
 * these three carry `machineVerb: 'use'`) so "forgot to declare it" and "this is
 * not a `use` command" cannot look alike.
 */
const USE_ERRORS = {
  callerSuppliedTargetId: true,
  invisibleFailsAs: 'nonexistent',
  distinguishesUnauthorizedFromUnreachable: true,
  note:
    'THE ONE PLACE IN THIS FAMILY WHERE M5 OVERRIDES D20.2, and `classificationErrors` requires it: a ' +
    '`use` command that could not distinguish unauthorized from unreachable would answer "no repos" ' +
    'identically for a denied grant and a dead daemon, and readiness §3.1.4 M5 says in as many words ' +
    'that those produce the same empty list and the same support ticket. The boundary is D18.5’s: the ' +
    'distinction holds INSIDE the caller’s `see` set, where existence is already disclosed. A machine ' +
    'it cannot see is absent and fails as a nonexistent id, which is why `invisibleFailsAs` is still ' +
    '`nonexistent` — the two rules are decided separately and both apply, in that order.',
} as const

export const discoveryRefreshReposContract = {
  name: 'discovery.refreshRepos',
  version: 1,
  visibility: 'owned-compute',
  input: discoveryRefreshReposInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'use',
    confirmation: 'none',
    rationale:
      'Fans a `scanRepos` request out to every ONLINE machine and asks each to inspect its own ' +
      'registered roots. That is work executed on owned compute — ADR 9 D6 M1’s "read/write files" — ' +
      'so `use`, with M2’s code-execution boundary behind it, even though the walk is bounded ' +
      '(`maxDepth: 0`, no home sweep). What it writes back is the scan-reported origin on registered ' +
      'repo rows, which is the same `owned-compute` row the rest of this family writes.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: {
    creates: [],
    note: 'Enriches existing repo rows with scan-reported origins; registers nothing new.',
  },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note:
      'The only command in the family with NO input at all: the machine set is derived server-side ' +
      'from who is online, never named by the caller. So D20 has no target id to govern — and M5’s ' +
      'distinction is carried by the per-machine `diagnostics[]` in the result, which is where an ' +
      'offline daemon is already reported ("no daemons online") rather than being silently absent.',
  },
  serverRole: 'core',
  cli: { summary: 'Re-scan registered repositories on every online machine' },
} as const satisfies FleetCommandContract<typeof discoveryRefreshReposInput>

export const discoveryScanFolderContract = {
  name: 'discovery.scanFolder',
  version: 1,
  visibility: 'owned-compute',
  input: discoveryScanFolderInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'use',
    confirmation: 'none',
    rationale:
      'Walks a user-picked folder on the TARGET machine to a bounded depth. Unambiguously `use`: it ' +
      'reads that machine’s filesystem outside anything already registered, which is precisely the ' +
      'blast radius M2 describes. It persists nothing — and it is still classified `owned-compute` ' +
      'rather than left unclassified, because what it DISCLOSES is a per-machine fact and ADR 9 D3 ' +
      'rule 3 scopes those to the machine. Classifying it `personal` would key one machine’s directory ' +
      'listing to whoever happened to ask for it.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: {
    creates: [],
    note: 'Returns candidates for the selection screen; registers nothing — `repos.addMany` is what persists a selection.',
  },
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: USE_ERRORS,
  serverRole: 'core',
  cli: { summary: 'Scan a folder on a machine for repositories' },
} as const satisfies FleetCommandContract<typeof discoveryScanFolderInput>

export const discoveryScanMachineContract = {
  name: 'discovery.scanMachine',
  version: 1,
  visibility: 'owned-compute',
  input: discoveryScanMachineInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    machineVerb: 'use',
    confirmation: 'none',
    rationale:
      'The tiered per-machine discovery (POD-787): probes of known paths, shallow walks around known ' +
      'repos, and with `deep` a bounded $HOME sweep — all on the named machine. `use`, and the widest ' +
      '`use` in this family. Unlike `scanFolder` it WRITES: origin matches are auto-registered as repo ' +
      'rows, which is why its ownership cell names what it creates.',
  },
  exposure: SERVED_ON,
  delivery: FLEET_DELIVERY,
  redaction: PUBLIC_REDACTION,
  ownership: REPO_ROW_OWNERSHIP('Auto-registers origin matches. ' + REPO_ROW_NOTE),
  attribution: FLEET_ATTRIBUTION,
  errorConsistency: USE_ERRORS,
  serverRole: 'core',
  cli: { summary: 'Discover repositories on a machine' },
} as const satisfies FleetCommandContract<typeof discoveryScanMachineInput>

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * THE TWELVE, keyed by their dotted wire name.
 *
 * `discovery.scan` is NOT here and its absence is deliberate: despite the name it
 * scans CONVERSATIONS (`rpc.scan()` returns `{ conversations, diagnostics }`),
 * not repos, so it belongs to the session-discovery family rather than to fleet.
 * Migrating it here would have been a scope grab justified by a shared router
 * name. It is named in POD-384's report as deliberately not done.
 */
export const FLEET_CONTRACTS = {
  'machines.rename': machineRenameContract,
  'machines.share': machineShareContract,
  'machines.unshare': machineUnshareContract,
  'machines.revoke': machineRevokeContract,
  'machines.pairingCode': machinePairingCodeContract,
  'repos.add': repoAddContract,
  'repos.addMany': repoAddManyContract,
  'repos.remove': repoRemoveContract,
  'repos.setPrefix': repoSetPrefixContract,
  'discovery.refreshRepos': discoveryRefreshReposContract,
  'discovery.scanFolder': discoveryScanFolderContract,
  'discovery.scanMachine': discoveryScanMachineContract,
} as const satisfies Record<string, FleetCommandContract>

export type FleetContractName = keyof typeof FLEET_CONTRACTS

/** Every fleet contract, erased — what the classification lint takes. */
export const FLEET_CONTRACT_LIST = Object.values(FLEET_CONTRACTS)

/** The dotted names, in table order. */
export const FLEET_COMMAND_NAMES = Object.keys(FLEET_CONTRACTS) as readonly FleetContractName[]

/**
 * The server role that serves `name`, default-closed on an unknown name: a typo
 * resolves to the HUB role, which is the smaller surface, rather than to `core`
 * (which would silently widen where a command is served).
 *
 * `Object.hasOwn`, not `in` — and the difference is not hypothetical here. `in`
 * walks the prototype chain, so `fleetServerRoleOf('constructor')` took the
 * "known command" branch and returned `undefined`, which is neither role and
 * would have flowed into the transport as a falsy "no hub gate". The same
 * own-key rule `RELAY_ALLOWED` already carries, for the same reason.
 */
export const fleetServerRoleOf = (name: string): FleetServerRole =>
  Object.hasOwn(FLEET_CONTRACTS, name)
    ? FLEET_CONTRACTS[name as FleetContractName].serverRole
    : 'hub'
