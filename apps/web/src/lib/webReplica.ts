/**
 * THE BROWSER'S REPLICA COMPOSITION ROOT (POD-1239).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAD TO EXIST BEFORE THE BUG COULD BE FIXED
 * ---------------------------------------------------------------------------
 *
 * POD-307 specifies the client's persisted store as fail-closed: a store that
 * cannot be attributed to the current principal is DISCARDED and re-bootstrapped,
 * never adopted. POD-377 built the gate, POD-378 verified it, and no client ever
 * called it — every site that opens persisted client storage skipped the question.
 *
 * The web client's construction had no HOME of its own. `AppShell` passes
 * `createReplicaFn` only when the kernel-replica flag resolves to `kernel` or the
 * Tauri SQLite factory resolved; a plain browser with the flag off passed nothing,
 * the engine called `createReplica()` with no argument, and the replica resolved
 * `window.localStorage` itself. So the SHIPPING browser path adopted whatever the
 * last person on the device left behind.
 *
 * The audit was NOT blind to this — measured, not assumed: on integration it
 * reported `packages/client-core/src/engine/engine.ts:297`. The defect was that the
 * finding named a file that COULD NOT HOST ITS OWN FIX. `engine.ts` is shared and
 * platform-neutral; attribution needs the current principal, which client-core has
 * no way to know. A web agent reading that finding would find nothing there to do.
 *
 * Hence: the ambient reach is gone from the replica (`legacyMigrationStorage`), the
 * engine REQUIRES a factory, and the browser's construction happens HERE — in a web
 * file, where the answer can actually be wired. Audit membership moves by exactly
 * one, `engine.ts:297` out and this file in; the count does not change, because
 * nothing was hidden and nothing new exposed.
 *
 * ---------------------------------------------------------------------------
 * AND THE GATE IT WAS BUILT TO HOST (POD-1252)
 * ---------------------------------------------------------------------------
 *
 * POD-1239 stopped one line short on purpose — it left this root a FINDING rather
 * than inventing a second attribution call while POD-1223 owned the web client's
 * identity plumbing. POD-1223 shipped (`kernelReplica.ts`), so the collision it was
 * avoiding no longer exists and the call lands here.
 *
 * WHICH FAMILIES A REFUSAL TOUCHES is not obvious and is decided in
 * `legacyStoreAttribution.ts`: entity rows and the cursor are DELETED, ui
 * preferences are LEFT, and queued work is PARKED — never adopted, never destroyed.
 * The distinction matters because POD-1220 found the failure mode where a gate has
 * a caller and no effect: on their root, entities and the cursor were retired
 * unconditionally either way, so only the outbox binding made the call mean
 * anything. Here it is the reverse — this replica KEEPS serving the store it opens,
 * so the entity discard is the load-bearing effect, and
 * `webReplica.attribution.test.ts` measures it by re-opening the same store and
 * requiring the rows to be gone.
 */

import {
  createReplica,
  preparePrincipalNamespace,
  REPLICA_KEY_PREFIX,
  type Replica,
  type StorageApi,
  type StorageEventApi,
} from '@podium/client-core/replica'
import {
  decideLegacyAdoption,
  type LegacyIdentityEvidence,
} from '@podium/sync/adapters/legacy-replica'
import {
  defaultWebEvidence,
  discardUnattributedEntityRows,
  NO_IMPORT_PLAN,
  parkUnattributedOutbox,
  WEB_REPLICA_PRINCIPAL,
} from './legacyStoreAttribution'

export interface CreateWebReplicaOptions {
  /** Authenticated principal whose slice and every persisted key this is. */
  readonly principal?: string
  /**
   * WHO THIS DEVICE'S EXISTING STORE BELONGS TO — the attribution gate's input.
   *
   * Defaults to `single-account` under the shared-password grade; injected rather
   * than hardcoded so a test can present `unknown` or a foreign ledger and observe
   * the REFUSAL. See {@link defaultWebEvidence} for why the default is a claim
   * about this tree rather than a convenience.
   */
  readonly evidence?: LegacyIdentityEvidence
  /**
   * Seam for tests; defaults to the browser's own store.
   *
   * The three ambient values move together, because they describe ONE store: a
   * caller that injects storage and inherits `window` for the other two would get
   * cross-tab events and a key enumeration belonging to a different store than the
   * one the collections read. That coupling — injecting a store silently changing
   * an unrelated behaviour — is the defect POD-1239 removed from the replica
   * itself, and re-introducing it one layer up would be the same bug in a new home.
   */
  readonly storage?: StorageApi
  readonly storageEventApi?: StorageEventApi
  readonly enumerateKeys?: () => string[]
  /** Clock seam, so a parked entry's `deadLetteredAt` is not a moving target. */
  readonly now?: () => number
  /** Surfaced rather than swallowed (ADR 6 D4.4): a discard is a real state a
   *  person notices, and `redactedCount` is work that lost its payload. */
  readonly onDiscarded?: (detail: { reason: string; redactedCount: number }) => void
}

/**
 * Everything ambient, stated.
 *
 * These three used to be implicit defaults inside the replica, each keyed on
 * `init.storage === undefined` — so injecting a store silently also turned off
 * cross-tab sync and the ui-state key enumeration. Passing them explicitly keeps
 * the browser's behaviour byte-for-byte what it was while removing the coupling:
 * the replica no longer infers "you are the real browser" from an absent argument.
 *
 *  - `storage`          the durable web store the collections persist into.
 *  - `storageEventApi`  cross-tab consistency (another tab's write repaints this one).
 *  - `enumerateKeys`    the one-time ui-state migration folds prefix-matched legacy
 *                       keys in, and prefix matching cannot probe keys individually.
 */
export function createWebReplica(options: CreateWebReplicaOptions = {}): Replica {
  const storage = options.storage ?? window.localStorage
  const now = options.now ?? Date.now
  const injected = options.storage !== undefined
  const enumerateKeys =
    options.enumerateKeys ?? (injected ? () => [] : () => Object.keys(window.localStorage))
  const namespace = preparePrincipalNamespace({
    storage,
    enumerateKeys,
    basePrefix: REPLICA_KEY_PREFIX,
    principal: options.principal ?? WEB_REPLICA_PRINCIPAL,
    now: () => now(),
  })

  // ---- THE ATTRIBUTION GATE, before a single row is read -------------------
  //
  // Called with an EMPTY plan on purpose: the decision and the records are two
  // things `decideLegacyAdoption` returns, and only the decision applies at a root
  // that migrates nothing into the kernel store. Re-deriving the rule locally
  // would fork it, and a second copy of a privacy rule is worse than an off-label
  // call to the first.
  const adoption = decideLegacyAdoption(
    NO_IMPORT_PLAN,
    options.evidence ?? defaultWebEvidence(WEB_REPLICA_PRINCIPAL),
    now(),
  )
  if (!adoption.adopt) {
    // FAIL CLOSED, and BEFORE the construction below: the legacy replica loads its
    // collections out of storage as it is built, so a discard that ran afterwards
    // would be a discard of rows the engine could already have been handed.
    discardUnattributedEntityRows(storage)
  }

  // The browser's three ambient values, unchanged when nothing is injected —
  // POD-1239's "byte-for-byte what it was" still holds. An injected store gets
  // NEITHER of the other two by default; see the options doc for why.
  const replica = createReplica({
    ...(namespace.durable
      ? {
          storage,
          storageEventApi: options.storageEventApi ?? (injected ? undefined : window),
          enumerateKeys,
        }
      : {}),
    keyPrefix: namespace.keyPrefix,
  })

  if (!adoption.adopt) {
    // The namespaced cache may be invisible to an injected store's deliberately
    // absent key enumerator. Reset through the replica as well so its in-memory
    // collections and cursor are empty before any caller can observe them; the
    // reset contract preserves every outbox home and UI state.
    replica.resetCache()
    // AFTER the construction, because the three outbox homes are read through the
    // replica's own seams — one decoder shared with the writer rather than a
    // second parse of the collection blob format.
    const redactedCount = parkUnattributedOutbox(replica, now())
    console.warn(
      `[podium] web replica store not adopted (${adoption.reason}) — rows discarded, ${redactedCount} queued entr${redactedCount === 1 ? 'y' : 'ies'} parked`,
    )
    options.onDiscarded?.({ reason: adoption.reason, redactedCount })
  }

  return replica
}
