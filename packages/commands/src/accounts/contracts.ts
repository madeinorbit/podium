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
 */

import { AccountIdField } from '@podium/model'
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

export const accountsConnectContract = {
  name: 'accounts.connect',
  version: 1,
  visibility: ACCOUNT_VISIBILITY,
  input: accountsConnectInput,
  policy: {
    action: 'manage',
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'none',
    rationale:
      'Stores credential material Podium will INJECT INTO SPAWNED AGENT PROCESSES, so `resource: ' +
      'secret` — which also forces `online-sensitive` through the lint — and `manage`/`admin`, ' +
      'because whoever writes this decides which account every agent on this instance bills and ' +
      'acts as. That is strictly stronger than any per-entity write, which is why it is not graded ' +
      '`write` despite being a single row insert. No confirmation: connecting is additive and ' +
      'reversible by `disconnect`, and the destructive direction carries the gate.',
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
      'than `parent` because there is no parent to inherit from: a credential is instance-scoped, ' +
      'and the only meaningful owner is the person accountable for it.',
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
    roleFloor: 'admin',
    resource: 'secret',
    confirmation: 'confirm',
    rationale:
      'Removes a stored credential. Same grade and resource as `connect`; what differs is ' +
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
      'distinguishable.',
  } satisfies ErrorConsistency,
  conflict: 'cmd',
  conflictRule: 'Idempotent revocation; disconnecting an already-disconnected account is a no-op',
} as const satisfies CommandContract<typeof accountsDisconnectInput>

export const ACCOUNT_CONTRACTS = {
  connect: accountsConnectContract,
  disconnect: accountsDisconnectContract,
} as const

export type AccountContractName = keyof typeof ACCOUNT_CONTRACTS

export const ACCOUNT_CONTRACT_NAMES = Object.keys(ACCOUNT_CONTRACTS).sort() as AccountContractName[]
