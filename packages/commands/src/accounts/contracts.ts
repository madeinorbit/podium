/**
 * THE ACCOUNT CONTRACTS — `accounts.connect · accounts.disconnect · accounts.share ·
 * accounts.login · accounts.send · accounts.useOnMyMachines`.
 *
 * Credentials belong to the connecting member. Another member may use a managed
 * key only through an explicit share; foreign-machine sends still require the
 * credential owner's consent. Admin never implies credential or machine use.
 *
 * The Accounts & Keys hub (SP-6454): the managed credentials Podium holds and
 * injects at spawn. The `list` read stays a query — and note what it returns,
 * because it is why this family can be served at all: an `AccountView` carries a
 * MASKED `identity`, never the credential.
 *
 * ---------------------------------------------------------------------------
 * THE INPUT SCHEMA MOVED HERE, AND THAT IS THE POINT RATHER THAN A SIDE EFFECT
 * ---------------------------------------------------------------------------
 *
 * `AccountConnectInput` lived in `apps/server/src/accounts.ts` and was reached by
 * the router. It is declared here now, because a contract that RESTATED it would
 * be the second declaration POD-305 measured: a restatement is byte-identical on
 * the wire and passes every golden fixture while drifting from what it was copied
 * from. There is one instance; the contract and the server read the same object.
 *
 * NO RE-EXPORT SHIM was left behind — both call sites were repointed. A shim
 * would have made the move invisible and would have added to the `reexport-shims`
 * ratchet the deletion audit counts, which is the opposite of absorbing a
 * duplicate. The same rule this package's own header records for POD-311.
 *
 * ---------------------------------------------------------------------------
 * CLASSIFICATION: `secret`, AND THE LINT MAKES IT STRUCTURAL
 * ---------------------------------------------------------------------------
 *
 * ADR 1's `managedCredentials` row declares `visibility: 'secret'`,
 * `secret: 'secret-value'` and `offline: 'never-enqueue'`. A `secret` class
 * forces `online-sensitive` delivery through `classificationErrors`, so the thing
 * that matters most — a credential is never queued, never replayed — is enforced
 * by the type rather than promised in a comment.
 */

import { AccountIdField, HarnessAgent, MachineIdField, UserIdField } from '@podium/model'
import { z } from 'zod'
import type {
  AttributionPolicy,
  CommandContract,
  DeliveryPolicy,
  ErrorConsistency,
  RedactionPolicy,
  TransportTag,
  VisibilityClass,
} from '../contract'

/** `trpc` alone — the Accounts hub is the only surface that writes these. */
const SERVED_ON: readonly TransportTag[] = ['trpc']

/** ADR 1's `managedCredentials` row. */
const ACCOUNT_VISIBILITY: VisibilityClass = 'secret'

/**
 * ADR 3 D4 rule 1, forced by the lint AND correct on its own terms — the matrix
 * row says `never-enqueue` independently, which is the same claim from the other
 * direction. Two mechanisms, neither substituting for the other.
 */
const ACCOUNT_DELIVERY: DeliveryPolicy = {
  class: 'online-sensitive',
  outboxReconciliation:
    'NEVER queued. A queued `connect` would leave the credential sitting in a client Outbox until ' +
    'drain — precisely the durable unaudited copy this class exists to prevent — and a queued ' +
    '`disconnect` would leave a revoked credential live for the length of an offline window.',
  applyTimeReauthorization:
    'Not reachable in practice, since the class forbids queuing; stated for totality (ADR 3 D8). A ' +
    'credential write is authorized live or not at all.',
}

/** ADR 9 D5 A3 / Amendment 1 D17. For credentials the pair outlives the
 *  credential: rotating a key does not answer "who put the old one here". */
const ACCOUNT_ATTRIBUTION: AttributionPolicy = {
  actor: 'from-capability',
  onBehalfOf: 'from-delegation',
  wirePlacement: 'separate-field',
  reservedWireKeys: ['actor', 'onBehalfOf'],
  rationale:
    'Both halves from the transport principal, never from payload — and here the stamping does real ' +
    'work rather than bookkeeping, because an agent must not be able to record a credential as ' +
    'having been connected by its human. The `id` is derived server-side from provider and kind, so ' +
    'it is a routing address and D17 forbids it doubling as the accountability record.',
}

/**
 * OAuth is Anthropic-only: `claude setup-token` yields the sole long-lived,
 * env-consumable OAuth credential — for any other provider an oauth row would
 * persist fine but inject NOTHING at spawn (`credentialEnv` maps oauth →
 * `CLAUDE_CODE_OAUTH_TOKEN` only for anthropic), a silently dead credential.
 * Rejected loudly at the boundary instead.
 *
 * MOVED VERBATIM, `superRefine` and all. The refinement is part of the input
 * VOCABULARY rather than of the handler, which is exactly why it belongs on the
 * contract: every transport serving this command inherits the same refusal.
 */
export const AccountConnectInput = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'openrouter']),
    kind: z.enum(['api-key', 'oauth']),
    credential: z.string().min(1),
  })
  .superRefine((input, ctx) => {
    if (input.kind === 'oauth' && input.provider !== 'anthropic') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message:
          "OAuth accounts are only supported for Anthropic (claude setup-token); use kind 'api-key' for other providers.",
      })
    }
  })

export const accountsConnectInput = AccountConnectInput

export const accountsLoginInput = z.object({
  harness: HarnessAgent,
  machineId: MachineIdField.optional(),
})

export const accountsConnectContract = {
  name: 'accounts.connect',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsConnectInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Stores credential material Podium will INJECT INTO SPAWNED AGENT PROCESSES, so `resource: ' +
      'secret` — which also forces `online-sensitive` through the lint — graded `write`/`member`. ' +
      'Every member connects their OWN accounts: an agent cannot connect as its human, and a key ' +
      'reaches another member only through an explicit share. Connecting is additive and ' +
      'reversible by `disconnect`; the destructive direction carries the gate.',
  },
  exposure: SERVED_ON,
  delivery: ACCOUNT_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: ['credential'],
    outputPaths: [],
    note:
      '`credential` is the secret itself and is redacted from every log and audit record. THE OUTPUT ' +
      'IS THE OTHER HALF OF THIS REVIEW and is why `outputPaths` is empty rather than unexamined: ' +
      'the handler returns ONLY `{ id }`. The credential is never echoed to a client, and what the ' +
      '`list` read shows is `maskCredential`’s display-only preview — the full value never leaves ' +
      'the server.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: ['managed-credential'],
    owner: 'on-behalf-of-human',
    visibility: ACCOUNT_VISIBILITY,
    inheritanceOnCreate: 'on-behalf-of-human',
    note:
      'Mints a managed credential row owned by the signed-in caller (agents are refused, so the ' +
      'on-behalf-of human and the actor are the same person). `inheritanceOnCreate: ' +
      'on-behalf-of-human` rather than `parent` because there is no parent to inherit from: the ' +
      'only meaningful owner is the person accountable for it. It starts private.',
  },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note:
      'The account id is DERIVED SERVER-SIDE from provider and kind, and the owner is the caller, ' +
      'so there is no caller-controlled target to iterate and no existence to leak. That is a ' +
      'property of the handler, stated here rather than left to be inferred from the schema.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule:
    'ROW.managedCredentials / ROW.accountCredential; one live credential per (owner, account id), so a reconnect REPLACES the stored material and keeps its sharing and machine consent rather than accumulating a second',
} as const satisfies CommandContract<typeof accountsConnectInput>

export const accountsDisconnectInput = z.object({ id: AccountIdField })

export const accountsDisconnectContract = {
  name: 'accounts.disconnect',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsDisconnectInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'Removes one of the CALLER’S OWN stored credentials (POD-6360); another user’s key is ' +
      'untouched, and naming one fails exactly as a key that does not exist. Same grade and ' +
      'resource as `connect`; what differs is ' +
      '`confirmation: "confirm"`, because this is the destructive direction and ADR 1’s row is ' +
      '`hard-delete` — the value is GONE, no tombstone, no recovery, and every agent spawning ' +
      'against it starts failing. ADR 3 D2 puts destructive writes behind a confirmation. Worth ' +
      'knowing for the UI: a `legacy` account has no row at all (the value comes from pre-hub ' +
      '`settings.apiKeys`), so removal would delete NOTHING — the hub must not offer a Disconnect ' +
      'the server cannot honour.',
  },
  exposure: SERVED_ON,
  delivery: ACCOUNT_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The input is an opaque server-minted id — `managed:anthropic`, `managed:claude-oauth` — which ' +
      'names a provider and a kind but carries no secret material. The result is `{ ok: true }`.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: [],
    note: 'Removes the caller’s own credential row. Mints no entity; the row is hard-deleted rather than re-homed.',
  },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'The `id` IS caller-supplied here, unlike `connect`, so D20.2 governs: an account this ' +
      'principal may not see fails exactly as one that does not exist — and the id space is ' +
      'guessable (`managed:<provider>`), which makes the oracle a real one rather than theoretical. ' +
      'M5’s carve-out does not apply, since no machine is nameable, so there is nothing to keep ' +
      'distinguishable.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule: 'Idempotent revocation; disconnecting an already-disconnected account is a no-op',
} as const satisfies CommandContract<typeof accountsDisconnectInput>

export const accountsShareInput = z.object({
  /** The public account id (`managed:anthropic`), as `list` shows it. */
  id: AccountIdField,
  /** Whose key. Omitted: the caller's own. Another user's needs an admin. */
  owner: UserIdField.optional(),
  /** Share with every user of this instance. */
  everyone: z.boolean(),
  /** Share with these users. The pair replaces the old sharing; both empty = private. */
  users: z.array(UserIdField).max(256).default([]),
})

export const accountsShareContract = {
  name: 'accounts.share',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsShareInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Decides whose agents may use a stored key (POD-6360, user decision 2026-11-04): with ' +
      'everyone, with named users, or (both empty) nobody but its owner. `secret` like the rest of ' +
      'the family. Only the key’s owner or an admin may change it, which the target check ' +
      'decides: `member` may attempt it for their own key, and naming another `owner` needs the ' +
      'admin role. An agent may not share its human’s key. No confirmation: sharing is reversible ' +
      'by sharing with nobody, and revoking stops the next spawn.',
  },
  exposure: SERVED_ON,
  delivery: ACCOUNT_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The input names an account id, an owner and grantees; none is secret. The result is ' +
      '`{ ok: true }`. The credential is not read.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: [],
    note: 'Changes who may use an existing credential row. Mints no entity and moves no ownership.',
  },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'The account id and owner are caller supplied. A member naming another user’s key is ' +
      'refused before any read, and a key that does not exist answers the same "no such key", so ' +
      'the reply says nothing about whether another user holds one.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule:
    'Replaces the whole sharing list of one (owner, account id) row; last write wins, and the next spawn reads it',
} as const satisfies CommandContract<typeof accountsShareInput>

export const accountsLoginContract = {
  name: 'accounts.login',
  version: 1,
  visibility: 'owned-compute',
  input: accountsLoginInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'machine',
    confirmation: 'none',
    machineVerb: 'use',
    rationale:
      'Starts an interactive provider CLI on owned compute. It changes the native account every agent on that host runs with, and a machine’s native logins belong to the person who looks after it (POD-6300), so a member may log in only on a machine in their own custody; on anyone else’s it would replace that person’s login and is refused.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never queued: an operator must be present for the interactive login PTY.',
    applyTimeReauthorization: 'Machine use, for the calling user, is checked live at apply time.',
  },
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'Only harness, machine and session identifiers cross this boundary; provider tokens stay inside the native CLI.',
  },
  ownership: { creates: [], note: 'Creates an ephemeral operator PTY, not a new owned entity.' },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: true,
    note: 'A selected machine is caller supplied; machine-use errors distinguish access from reachability.',
  },
  conflict: 'cmd',
  conflictRule: 'One active login attempt per (member, harness) is reused until it settles.',
} as const satisfies CommandContract<typeof accountsLoginInput>

/**
 * `accounts.send` (POD-6300; design §2.4, Q1). A connection runs on its owner's
 * own machines without being sent. To run on SOMEONE ELSE'S machine (one the
 * owner holds `use` on), the owner explicitly sends it there, and has to
 * acknowledge that everyone running on that machine's OS account can read it.
 */
export const accountsSendInput = z.object({
  id: AccountIdField,
  machineId: MachineIdField,
  /** The caller saw the shared-machine warning and sends anyway. */
  acknowledgeSharedMachine: z.boolean().optional(),
})

export const accountsSendContract = {
  name: 'accounts.send',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsSendInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'Lets the caller’s OWN credential be injected into their runs on another person’s machine, ' +
      'where everyone running under that OS account can read it. The confirmation is the ' +
      'shared-machine warning, which the caller must acknowledge; the machine must be one the ' +
      'caller may use, and only the caller’s own connection can be sent.',
  },
  exposure: SERVED_ON,
  delivery: ACCOUNT_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note: 'The input names an account id and a machine; the result is `{ ok, warning }`. No secret crosses.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: ['managed-credential machine send'],
    owner: 'on-behalf-of-human',
    visibility: ACCOUNT_VISIBILITY,
    inheritanceOnCreate: 'parent',
    note: 'The send record belongs to the credential it names, and goes with it on disconnect.',
  },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'Another member’s connection with this id is the caller’s missing one; a machine the caller ' +
      'may not use is refused the same as an unknown machine.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule: 'Idempotent per (connection, machine); sending again changes nothing',
} as const satisfies CommandContract<typeof accountsSendInput>

/**
 * `accounts.useOnMyMachines` — THE D11 CHECKBOX (POD-6301; design §2.5, §4.6;
 * September addendum §4-5). One native login, named by harness and identity
 * fingerprint, is ticked or unticked for "use this connection on all machines I
 * hold custody of, now and in future".
 */
export const accountsUseOnMyMachinesInput = z.object({
  harness: HarnessAgent,
  /** The login's identity fingerprint, as the Accounts list reports it. */
  fingerprint: z.string().min(1).max(256),
  enabled: z.boolean(),
})

export const accountsUseOnMyMachinesContract = {
  name: 'accounts.useOnMyMachines',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsUseOnMyMachinesInput,
  policy: {
    action: 'write',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Decides whether Podium copies the caller’s OWN native login to the other machines in the ' +
      'caller’s custody and uses it there. Only the caller’s custody machines are ever reached, ' +
      'so the member floor widens nobody’s reach. Ticking a login is refused unless it is ' +
      'observed on one of the caller’s own machines. No confirmation: ticking copies only into ' +
      'empty slots of the caller’s own machines, never over another login, and unticking only ' +
      'stops future copies (it recalls nothing, which the UI says once beside the box).',
  },
  exposure: SERVED_ON,
  delivery: ACCOUNT_DELIVERY,
  redaction: {
    reviewed: true,
    inputPaths: [],
    outputPaths: [],
    note:
      'The input names a harness and an identity fingerprint (a one-way hash of the account id), ' +
      'never credential material. The result is `{ ok, enabled }`.',
  } satisfies RedactionPolicy,
  ownership: {
    creates: ['native-login opt-in'],
    owner: 'on-behalf-of-human',
    visibility: ACCOUNT_VISIBILITY,
    inheritanceOnCreate: 'on-behalf-of-human',
    note: 'The choice belongs to the human it was made on behalf of; nobody else reads or changes it.',
  },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: true,
    invisibleFailsAs: 'nonexistent',
    distinguishesUnauthorizedFromUnreachable: false,
    note:
      'A fingerprint not observed on one of the caller’s own machines is refused exactly like one ' +
      'that exists nowhere, so the command says nothing about other members’ logins.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule:
    'Last write wins per (member, harness, fingerprint); every change bumps the revision, so a copy exported under the old choice is refused as stale',
} as const satisfies CommandContract<typeof accountsUseOnMyMachinesInput>

export const ACCOUNT_CONTRACTS = {
  connect: accountsConnectContract,
  disconnect: accountsDisconnectContract,
  share: accountsShareContract,
  login: accountsLoginContract,
  send: accountsSendContract,
  useOnMyMachines: accountsUseOnMyMachinesContract,
} as const

export type AccountContractName = keyof typeof ACCOUNT_CONTRACTS

export const ACCOUNT_CONTRACT_NAMES = Object.keys(ACCOUNT_CONTRACTS).sort() as AccountContractName[]
