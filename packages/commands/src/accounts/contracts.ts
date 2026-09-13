/**
 * THE TWO ACCOUNT CONTRACTS — `accounts.connect · accounts.disconnect`.
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
 *
 * ---------------------------------------------------------------------------
 * THE FAMILY NO LONGER SHARES ONE FLOOR, AND THAT IS THE DESIGN (PDM-302)
 * ---------------------------------------------------------------------------
 *
 * `connect` and `disconnect` are `member`. `login` is `admin`. A reader meeting
 * that split will reasonably suspect a half-finished edit, so: it is not.
 *
 * The two credential writes were graded `admin` because the managed credential
 * was an INSTANCE-WIDE SINGLETON — one row every agent on the box billed
 * against. PDM-280 keyed it `(owner_user_id, id)`, and both handlers now write
 * and delete inside the CALLER'S OWN credentials. The floor was standing in for
 * an isolation the schema did not have; the schema has it, so the floor came
 * down to the grade a per-entity write actually deserves.
 *
 * `login` never had that property to lose. It drives the host's native CLI
 * credential store, which is shared by every agent on that machine no matter who
 * typed it, and it is bounded per-person by `machineVerb: 'use'` instead. Each
 * contract's own `rationale` carries the long form.
 */

import { AccountIdField, HarnessAgent, MachineIdField } from '@podium/model'
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
    action: 'manage',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Stores credential material Podium will INJECT INTO SPAWNED AGENT PROCESSES, so `resource: ' +
      'secret` — which also forces `online-sensitive` through the lint. THE FLOOR WAS `admin` AND ' +
      'IS NOW `member` (PDM-302); the reason is recorded here because a weakened floor invites the ' +
      'next reader to restore it. The old rationale justified `admin` like this: "whoever writes ' +
      'this decides which account EVERY AGENT ON THIS INSTANCE bills and acts as. That is strictly ' +
      'stronger than any per-entity write." That sentence was TRUE of an instance-wide singleton, ' +
      'and PDM-280 removed exactly the property it named — the row is keyed `(owner_user_id, id)` ' +
      'and the handler writes through `accounts.upsert(callerUserId, …)`, so connecting a key now ' +
      'decides what MY agents bill. It HAS BECOME the per-entity write the old rationale contrasted ' +
      'itself against, which is why `member` is the grade that matches rather than a concession. ' +
      'WHAT KEEPS THIS SAFE IS THE KEYING, NOT THE FLOOR: revert the row to an instance singleton ' +
      'and this must go back to `admin` in the same commit. No confirmation: connecting is additive ' +
      'and reversible by `disconnect`, and the destructive direction carries the gate.',
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
      'Mints a managed credential row owned by the human the write was made on behalf of, NOT by the ' +
      'agent that may have typed it (ADR 9 D5 A4). `inheritanceOnCreate: on-behalf-of-human` rather ' +
      'than `parent` because there is no parent entity to inherit from, and the only meaningful ' +
      'owner is the person accountable for it. Since PDM-280 that declaration is STORED rather ' +
      'than aspirational — the row carries `owner_user_id` — which is the fact PDM-302 lowered ' +
      'the floor on.',
  },
  attribution: ACCOUNT_ATTRIBUTION,
  errorConsistency: {
    callerSuppliedTargetId: false,
    note:
      'The row `id` is DERIVED SERVER-SIDE from provider and kind rather than supplied, so there is ' +
      'no caller-controlled target to iterate and no existence to leak. That is a property of the ' +
      'handler’s id minting, stated here rather than left to be inferred from the schema.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule:
    'ROW.managedCredentials / ROW.accountCredential; one live credential per (user, provider), so a reconnect REPLACES the stored material in one Authority commit rather than accumulating a second',
} as const satisfies CommandContract<typeof accountsConnectInput>

export const accountsDisconnectInput = z.object({ id: AccountIdField })

export const accountsDisconnectContract = {
  name: 'accounts.disconnect',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsDisconnectInput,
  policy: {
    action: 'manage',
    roleFloor: 'member',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'Removes a stored credential. Same grade and resource as `connect` — INCLUDING the `member` ' +
      'floor PDM-302 dropped it to, and for the same reason read from the other end: the handler ' +
      'deletes through `accounts.remove(callerUserId, id)`, so the only row this command can reach ' +
      "is the caller's own. A member disconnecting `managed:anthropic` removes THEIR slot and " +
      "leaves every other person's intact; that isolation is the property the floor used to stand " +
      'in for, and it is now structural. What differs from `connect` is ' +
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
    note: 'Removes an existing credential row. Mints no entity; the row is hard-deleted rather than re-homed.',
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
      'distinguishable. PDM-280 made that answer STRUCTURAL rather than a second error path: ' +
      "another person's row is not in this caller's namespace, so removing it does exactly what " +
      'removing a row that never existed does — nothing, silently. That is what let PDM-302 drop ' +
      'the floor here without opening an oracle.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule: 'Idempotent revocation; disconnecting an already-disconnected account is a no-op',
} as const satisfies CommandContract<typeof accountsDisconnectInput>

export const accountsLoginContract = {
  name: 'accounts.login',
  version: 1,
  visibility: 'owned-compute',
  input: accountsLoginInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'machine',
    confirmation: 'none',
    machineVerb: 'use',
    rationale:
      'Starts an interactive provider CLI on owned compute. It is admin-only and machine-use gated ' +
      'because it changes the native account available to every agent on that host. ' +
      'ITS FLOOR DID NOT MOVE WHEN `connect` AND `disconnect` DROPPED TO `member` (PDM-302), AND ' +
      'THE DIVERGENCE INSIDE ONE FAMILY IS DELIBERATE — do not harmonize it. PDM-280 gave MANAGED ' +
      "CREDENTIALS an owner column; a native login writes the HOST'S CLI credential store, which " +
      'is still shared by every agent on that machine, so the property the two credential writes ' +
      'lost is one this command never had. Its sentence above is still literally true. One further ' +
      "reason a hand edit here would still be wrong rather than merely early: `relay.ts`'s " +
      "`authorizerFor` hard-codes its own `role !== 'admin'` refusal OUTSIDE this contract " +
      '(PDM-309), so lowering the floor would change nothing a caller can observe and would ' +
      'leave this policy declaring what the server does not implement. THE SECOND REASON IS ' +
      'CLOSED, and is recorded rather than deleted because the floor it justified has not moved ' +
      'yet: `NativeLoginService.startInScope` reused an in-flight attempt by HARNESS alone, ' +
      'returning its session and machine BEFORE the machine-use recheck. PDM-281 keyed reuse by ' +
      "harness AND owner, so a stranger's attempt is unreachable rather than returned and no " +
      'reused path skips that recheck. Note what that defect was and was not, because only half ' +
      "of it was ever this floor's business: its DISCLOSURE half was bounded here, " +
      'admin-to-admin, and a lower floor would have widened it to anyone-to-admin; its ' +
      'machine-grant BYPASS half this floor never gated at all, and was live between two admins ' +
      'until PDM-281 closed it. This floor moves when PDM-309 closes, not before.',
  },
  exposure: SERVED_ON,
  delivery: {
    class: 'online-only',
    outboxReconciliation:
      'Never queued: an operator must be present for the interactive login PTY.',
    applyTimeReauthorization: 'Machine use and admin authority are checked live at apply time.',
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
  conflictRule:
    'One active login attempt per harness PER HUMAN is reused until it settles; a second human ' +
    'is refused on a host that already has one in flight.',
} as const satisfies CommandContract<typeof accountsLoginInput>

export const ACCOUNT_CONTRACTS = {
  connect: accountsConnectContract,
  disconnect: accountsDisconnectContract,
  login: accountsLoginContract,
} as const

export type AccountContractName = keyof typeof ACCOUNT_CONTRACTS

export const ACCOUNT_CONTRACT_NAMES = Object.keys(ACCOUNT_CONTRACTS).sort() as AccountContractName[]
