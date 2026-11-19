// workspace-scoped (POD-6959)
/**
 * CREDENTIALS — the records, their sealed secrets, where Podium placed them, and
 * which machines their owners allowed (credential management design §4).
 *
 * Every credential query lives here (docs/agents/server-data.md rule 6). The
 * repository never sees a plaintext secret: `putSecret` takes what the vault
 * sealed and `latestSecret` hands it back sealed. Only the vault opens it, and
 * only `withSecret` asks it to (`modules/credentials/vault.ts`).
 *
 * A record is never deleted by `remove`: its secrets are, and it stays as
 * `revoked` so sessions and events that name it still resolve to something.
 */

import { randomUUID } from 'node:crypto'
import {
  asCredentialId,
  CREDENTIAL_ID_PREFIX,
  type CredentialId,
  type MachineId,
  type UserId,
} from '@podium/model'
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm'
import type { credentialPlacements, credentials } from '../migrations/schema'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  sameWorkspace,
  WORKSPACE,
} from './executor/sync-drizzle'

export type CredentialStatus = 'ok' | 'attention' | 'revoked'

/** Who a credential is at its provider. Never a secret. */
export interface CredentialIdentity {
  fingerprint?: string
  email?: string
  plan?: string
  organisation?: string
  /** A display-only preview of a pasted secret. */
  masked?: string
}

/** A credential as stored, without any secret. */
export interface CredentialRecord {
  id: CredentialId
  ownerUserId: UserId
  label: string
  /** A key into the credential type registry, e.g. `anthropic.api-key`. */
  type: string
  identity: CredentialIdentity
  status: CredentialStatus
  statusReason: string | null
  expiresAt: string | null
  verifiedAt: string | null
  /** ISO time until which the provider reported a plan or rate limit reached. */
  limitReachedUntil: string | null
  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  legacyId: string | null
  /** The account id old sessions and settings recorded (`managed:anthropic`). */
  legacyKey: string | null
  createdAt: string
  updatedAt: string
}

export interface NewCredential {
  /** Minted here when absent. Given when the secret was sealed before the insert. */
  id?: CredentialId
  ownerUserId: UserId
  label: string
  type: string
  identity?: CredentialIdentity
  expiresAt?: string | null
  legacyId?: string | null
  legacyKey?: string | null
}

/** What the vault produced for one secret. The repository stores it as it is. */
export interface SealedSecret {
  ciphertext: Buffer
  nonce: Buffer
  /** The data key that sealed it. */
  keyId: string
}

/**
 * The newest stored secret of a credential. `openable` is false when the vault
 * cannot open it now: the vault is locked, or the secret was sealed under a data
 * key the vault no longer holds. Such a credential needs attention.
 */
export interface LatestSecret {
  version: number
  sealed: SealedSecret
  openable: boolean
}

/** The one thing this repository asks of the vault. */
export interface VaultKeyCheck {
  canOpen(keyId: string): boolean
}

export type PlacementKind = 'home' | 'propagated-file'
export type PlacementState = 'present' | 'removal-pending' | 'removed'

export interface PlacementRef {
  credentialId: CredentialId
  machineId: MachineId
  kind: PlacementKind
}

/** A placement as it is recorded: a home placement names the home it is. */
export interface PlacementRecord extends PlacementRef {
  /**
   * The daemon's id of the home (`<credentialId>:<harness>`), for a `home`
   * placement. It names another credential's id when a sign-in started for
   * one credential signed in as an account another credential already holds
   * (§10, review focus 5). Absent for a copied login file and for rows written
   * before it was recorded, where the home is the credential's own.
   */
  homeId?: string
}

export interface Placement extends PlacementRecord {
  state: PlacementState
  createdAt: string
  removedAt: string | null
}

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/** An `accounts` row as the one-time move reads it, with whether its owner is live. */
export interface LegacyAccountRow {
  id: string
  ownerUserId: UserId | null
  /** The owner exists and is not disabled. */
  ownerLive: boolean
  accountKey: string | null
  ref: string | null
  provider: string
  kind: string
  credential: string
  /** Who the owner shared it with: user ids, or `*` for everyone. */
  sharedWith: string[]
}

export interface StoredVaultKey {
  keyId: string
  wrapped: Buffer
}

type CredentialRow = typeof credentials.$inferSelect

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/** `accounts.shared_with`: a JSON list of user ids or `*`; anything else is private. */
function parseLegacySharedWith(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((g): g is string => typeof g === 'string' && g !== '')
  } catch {
    return []
  }
}

function parseIdentity(raw: string): CredentialIdentity {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CredentialIdentity = {}
    for (const key of ['fingerprint', 'email', 'plan', 'organisation', 'masked'] as const) {
      const value = (parsed as Record<string, unknown>)[key]
      if (typeof value === 'string' && value !== '') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function toStatus(raw: string): CredentialStatus {
  // The column has a CHECK; anything else is read as the narrowest standing.
  return raw === 'ok' || raw === 'attention' ? raw : 'revoked'
}

function toRecord(r: CredentialRow): CredentialRecord {
  return {
    id: asCredentialId(r.id),
    ownerUserId: r.ownerUserId,
    label: r.label,
    type: r.type,
    identity: parseIdentity(r.identity),
    status: toStatus(r.status),
    statusReason: r.statusReason,
    expiresAt: r.expiresAt,
    verifiedAt: r.verifiedAt,
    limitReachedUntil: r.limitReachedUntil,
    legacyId: r.legacyId,
    legacyKey: r.legacyKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

const toPlacementKind = (raw: string): PlacementKind =>
  raw === 'propagated-file' ? 'propagated-file' : 'home'
const toPlacementState = (raw: string): PlacementState =>
  raw === 'present' || raw === 'removal-pending' ? raw : 'removed'

function toPlacement(r: typeof credentialPlacements.$inferSelect): Placement {
  return {
    credentialId: asCredentialId(r.credentialId),
    machineId: r.machineId,
    kind: toPlacementKind(r.kind),
    ...(r.homeId ? { homeId: r.homeId } : {}),
    state: toPlacementState(r.state),
    createdAt: r.createdAt,
    removedAt: r.removedAt,
  }
}

// Every query this repository runs, prepared once per store [POD-6147].

const idIs = (t: StoreTables) => eq(t.credentials.id, param(t.credentials.id, 'id'))

const credentialById = prepared((db, t) =>
  db.select().from(t.credentials).where(inWorkspace(t.credentials, idIs(t))).prepare(),
)

const credentialsOfOwner = prepared((db, t) =>
  db
    .select()
    .from(t.credentials)
    .where(
      inWorkspace(
        t.credentials,
        eq(t.credentials.ownerUserId, param(t.credentials.ownerUserId, 'ownerUserId')),
        ne(t.credentials.status, 'revoked'),
      ),
    )
    .orderBy(asc(t.credentials.createdAt), asc(t.credentials.id))
    .prepare(),
)

const credentialByLegacyId = prepared((db, t) =>
  db
    .select()
    .from(t.credentials)
    .where(
      inWorkspace(
        t.credentials,
        eq(t.credentials.legacyId, param(t.credentials.legacyId, 'legacyId')),
      ),
    )
    .prepare(),
)

const credentialByLegacyKey = prepared((db, t) =>
  db
    .select()
    .from(t.credentials)
    .where(
      inWorkspace(
        t.credentials,
        eq(t.credentials.ownerUserId, param(t.credentials.ownerUserId, 'ownerUserId')),
        eq(t.credentials.legacyKey, param(t.credentials.legacyKey, 'legacyKey')),
      ),
    )
    .prepare(),
)

// LEGACY(remove-after: 2027-02): reads account ids written before t.credentials existed; removing it stops old spellings from resolving
/**
 * Other members' t.credentials imported from one old account id or its earlier
 * workspace alias, in the order the old shared read took them: the `accounts`
 * row's creation, then its id, oldest first; the `apiKeys.*` secrets, which had
 * no row, after them. Destroying the old plaintext copies each row's creation
 * time onto its credential before the row goes (`store/legacy-plaintext.ts`),
 * so the order is read from the credential, with its `legacy_id` (the row's id)
 * breaking ties.
 */
const legacySharedCandidates = prepared((db, t) =>
  db
    .select({ id: t.credentials.id, ownerUserId: t.credentials.ownerUserId })
    .from(t.credentials)
    .where(
      inWorkspace(
        t.credentials,
        or(
          eq(t.credentials.legacyKey, param(t.credentials.legacyKey, 'legacyKey')),
          eq(t.credentials.legacyKey, param(t.credentials.legacyKey, 'earlierKey')),
        ),
        ne(t.credentials.ownerUserId, param(t.credentials.ownerUserId, 'userId')),
        ne(t.credentials.status, 'revoked'),
      ),
    )
    .orderBy(
      asc(sql`substr(${t.credentials.legacyId}, 1, 8) = 'apiKeys.'`),
      asc(t.credentials.createdAt),
      asc(t.credentials.legacyId),
      asc(t.credentials.id),
    )
    .prepare(),
)

const credentialByIdentity = prepared((db, t) =>
  db
    .select()
    .from(t.credentials)
    .where(
      inWorkspace(
        t.credentials,
        eq(t.credentials.ownerUserId, param(t.credentials.ownerUserId, 'ownerUserId')),
        eq(t.credentials.type, param(t.credentials.type, 'type')),
        eq(t.credentials.identityFingerprint, param(t.credentials.identityFingerprint, 'fingerprint')),
        ne(t.credentials.status, 'revoked'),
      ),
    )
    .limit(1)
    .prepare(),
)

const insertCredential = prepared((db, t) =>
  db
    .insert(t.credentials)
    .values({
      workspaceId: WORKSPACE,
      id: sql.placeholder('id'),
      ownerUserId: sql.placeholder('ownerUserId'),
      label: sql.placeholder('label'),
      type: sql.placeholder('type'),
      identity: sql.placeholder('identity'),
      identityFingerprint: sql.placeholder('identityFingerprint'),
      status: 'ok',
      expiresAt: sql.placeholder('expiresAt'),
      legacyId: sql.placeholder('legacyId'),
      legacyKey: sql.placeholder('legacyKey'),
      createdAt: sql.placeholder('now'),
      updatedAt: sql.placeholder('now'),
    })
    .returning()
    .prepare(),
)

const renameCredential = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({ label: sql.placeholder('label'), updatedAt: sql.placeholder('now') })
    .where(inWorkspace(t.credentials, idIs(t)))
    .prepare(),
)

const setCredentialIdentity = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({
      identity: sql.placeholder('identity'),
      identityFingerprint: sql.placeholder('identityFingerprint'),
      updatedAt: sql.placeholder('now'),
    })
    .where(inWorkspace(t.credentials, idIs(t)))
    .prepare(),
)

const setCredentialStatus = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({
      status: sql.placeholder('status'),
      statusReason: sql.placeholder('statusReason'),
      updatedAt: sql.placeholder('now'),
    })
    .where(inWorkspace(t.credentials, idIs(t)))
    .prepare(),
)

const markCredentialVerified = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({ verifiedAt: sql.placeholder('at'), updatedAt: sql.placeholder('now') })
    .where(inWorkspace(t.credentials, idIs(t)))
    .prepare(),
)

const setCredentialExpiry = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({ expiresAt: sql.placeholder('expiresAt'), updatedAt: sql.placeholder('now') })
    .where(inWorkspace(t.credentials, idIs(t)))
    .prepare(),
)

const setCredentialLimit = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({ limitReachedUntil: sql.placeholder('until'), updatedAt: sql.placeholder('now') })
    .where(inWorkspace(t.credentials, idIs(t)))
    .prepare(),
)

/**
 * Move a working credential to `attention`, only if it is `ok` now: the row it
 * returns is the one transition, so two rejections at once raise one notice.
 */
const markCredentialAttention = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({
      status: 'attention',
      statusReason: sql.placeholder('statusReason'),
      updatedAt: sql.placeholder('now'),
    })
    .where(inWorkspace(t.credentials, idIs(t), eq(t.credentials.status, 'ok')))
    .returning({ id: t.credentials.id })
    .prepare(),
)

/** Credentials with a recorded expiry, not removed: what the expiry sweep reads. */
const credentialsWithExpiry = prepared((db, t) =>
  db
    .select()
    .from(t.credentials)
    .where(inWorkspace(t.credentials, isNotNull(t.credentials.expiresAt), ne(t.credentials.status, 'revoked')))
    .orderBy(asc(t.credentials.expiresAt), asc(t.credentials.id))
    .prepare(),
)

const secretIs = (t: StoreTables) =>
  eq(t.credentialSecrets.credentialId, param(t.credentialSecrets.credentialId, 'credentialId'))

const newestSecret = prepared((db, t) =>
  db
    .select()
    .from(t.credentialSecrets)
    .where(inWorkspace(t.credentialSecrets, secretIs(t)))
    .orderBy(desc(t.credentialSecrets.version))
    .limit(1)
    .prepare(),
)

const insertSecret = prepared((db, t) =>
  db
    .insert(t.credentialSecrets)
    .values({
      workspaceId: WORKSPACE,
      credentialId: sql.placeholder('credentialId'),
      version: sql.placeholder('version'),
      ciphertext: sql.placeholder('ciphertext'),
      nonce: sql.placeholder('nonce'),
      keyId: sql.placeholder('keyId'),
      createdAt: sql.placeholder('now'),
    })
    .prepare(),
)

const deleteOlderSecrets = prepared((db, t) =>
  db
    .delete(t.credentialSecrets)
    .where(
      inWorkspace(
        t.credentialSecrets,secretIs(t), lt(t.credentialSecrets.version, param(t.credentialSecrets.version, 'version'))),
    )
    .prepare(),
)

const deleteSecretsOf = prepared((db, t) =>
  db.delete(t.credentialSecrets).where(inWorkspace(t.credentialSecrets, secretIs(t))).prepare(),
)

/** Vault reset: every credential that has a sealed secret needs attention. */
const markSealedCredentialsForAttention = prepared((db, t) =>
  db
    .update(t.credentials)
    .set({
      status: 'attention',
      statusReason: sql.placeholder('statusReason'),
      updatedAt: sql.placeholder('now'),
    })
    .where(
      inWorkspace(
        t.credentials,
        ne(t.credentials.status, 'revoked'),
        sql`${t.credentials.id} IN (SELECT ${t.credentialSecrets.credentialId} FROM ${t.credentialSecrets} WHERE ${t.credentialSecrets.workspaceId} = ${WORKSPACE})`,
      ),
    )
    .returning({ id: t.credentials.id })
    .prepare(),
)

const deleteAllSecrets = prepared((db, t) => db.delete(t.credentialSecrets).where(inWorkspace(t.credentialSecrets)).prepare())

const placementIs = (t: StoreTables) =>
  inWorkspace(
    t.credentialPlacements,
    eq(t.credentialPlacements.credentialId, param(t.credentialPlacements.credentialId, 'credentialId')),
    eq(t.credentialPlacements.machineId, param(t.credentialPlacements.machineId, 'machineId')),
    eq(t.credentialPlacements.kind, param(t.credentialPlacements.kind, 'kind')),
  )

const upsertPlacement = prepared((db, t) =>
  db
    .insert(t.credentialPlacements)
    .values({
      workspaceId: WORKSPACE,
      credentialId: sql.placeholder('credentialId'),
      machineId: sql.placeholder('machineId'),
      kind: sql.placeholder('kind'),
      homeId: sql.placeholder('homeId'),
      state: 'present',
      createdAt: sql.placeholder('now'),
    })
    .onConflictDoUpdate({
      target: [
        t.credentialPlacements.workspaceId,
        t.credentialPlacements.credentialId,
        t.credentialPlacements.machineId,
        t.credentialPlacements.kind,
      ],
      // A home recorded again names the home it is now; a copy keeps none.
      set: { state: 'present', removedAt: null, homeId: sql`excluded."home_id"` },
    })
    .prepare(),
)

const placementsOf = prepared((db, t) =>
  db
    .select()
    .from(t.credentialPlacements)
    .where(
      inWorkspace(
        t.credentialPlacements,
        eq(
          t.credentialPlacements.credentialId,
          param(t.credentialPlacements.credentialId, 'credentialId'),
        ),
      ),
    )
    .prepare(),
)

/**
 * The owner's placements that are still on a machine (present, or waiting for
 * the machine to confirm their removal), with their credential (removed ones
 * too: that is when removal is pending). Led by the owner index; each
 * credential's placements by their primary key.
 */
const livePlacementsOfOwner = prepared((db, t) =>
  db
    .select({
      credential: t.credentials,
      machineId: t.credentialPlacements.machineId,
      kind: t.credentialPlacements.kind,
      homeId: t.credentialPlacements.homeId,
      state: t.credentialPlacements.state,
    })
    .from(t.credentials)
    .innerJoin(
      t.credentialPlacements,
      and(
        sameWorkspace(t.credentialPlacements, t.credentials),
        eq(t.credentialPlacements.credentialId, t.credentials.id),
      ),
    )
    .where(
      inWorkspace(
        t.credentials,
        eq(t.credentials.ownerUserId, param(t.credentials.ownerUserId, 'ownerUserId')),
        sql`${t.credentialPlacements.state} IN ('present', 'removal-pending')`,
      ),
    )
    // The owner index gives this order; each credential's placements follow
    // their primary key (credential, machine, kind).
    .orderBy(asc(t.credentials.createdAt), asc(t.credentials.id))
    .prepare(),
)

/** A machine's placements still waiting for it to confirm their removal. */
const pendingPlacementsOn = prepared((db, t) =>
  db
    .select()
    .from(t.credentialPlacements)
    .where(
      inWorkspace(
        t.credentialPlacements,
        eq(t.credentialPlacements.machineId, param(t.credentialPlacements.machineId, 'machineId')),
        // The partial index's own literal condition, so the planner can prove
        // `idx_credential_placements_pending` applies (server-data rule 3).
        sql`${t.credentialPlacements.state} = 'removal-pending'`,
      ),
    )
    .orderBy(asc(t.credentialPlacements.credentialId), asc(t.credentialPlacements.kind))
    .prepare(),
)

const setPlacement = prepared((db, t) =>
  db
    .update(t.credentialPlacements)
    .set({ state: sql.placeholder('state'), removedAt: sql.placeholder('removedAt') })
    .where(placementIs(t))
    .prepare(),
)

const machineIs = (t: StoreTables) =>
  inWorkspace(
    t.credentialMachines,
    eq(t.credentialMachines.credentialId, param(t.credentialMachines.credentialId, 'credentialId')),
    eq(t.credentialMachines.machineId, param(t.credentialMachines.machineId, 'machineId')),
  )

const insertAllowedMachine = prepared((db, t) =>
  db
    .insert(t.credentialMachines)
    .values({
      workspaceId: WORKSPACE,
      credentialId: sql.placeholder('credentialId'),
      machineId: sql.placeholder('machineId'),
      allowedBy: sql.placeholder('allowedBy'),
      createdAt: sql.placeholder('now'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deleteAllowedMachine = prepared((db, t) =>
  db.delete(t.credentialMachines).where(machineIs(t)).prepare(),
)

const allowedMachine = prepared((db, t) =>
  db
    .select({ credentialId: t.credentialMachines.credentialId })
    .from(t.credentialMachines)
    .where(machineIs(t))
    .prepare(),
)

/** Many t.credentials by id, not removed, in id order (the primary key). */
const credentialsByIds = preparedFamily((db, t, size: number) =>
  db
    .select()
    .from(t.credentials)
    .where(inWorkspace(t.credentials, inListOf(t.credentials.id, size, 'ids'), ne(t.credentials.status, 'revoked')))
    .orderBy(asc(t.credentials.id))
    .prepare(),
)

/** The allowed machines of many t.credentials, in primary-key order. */
const allowedMachinesOfMany = preparedFamily((db, t, size: number) =>
  db
    .select({
      credentialId: t.credentialMachines.credentialId,
      machineId: t.credentialMachines.machineId,
    })
    .from(t.credentialMachines)
    .where(inWorkspace(t.credentialMachines, inListOf(t.credentialMachines.credentialId, size, 'ids')))
    .orderBy(asc(t.credentialMachines.credentialId), asc(t.credentialMachines.machineId))
    .prepare(),
)

const theVaultKey = prepared((db, t) =>
  db.select().from(t.vaultKey).where(inWorkspace(t.vaultKey, eq(t.vaultKey.id, 1))).prepare(),
)

const insertVaultKey = prepared((db, t) =>
  db
    .insert(t.vaultKey)
    .values({
      workspaceId: WORKSPACE,
      id: 1,
      keyId: sql.placeholder('keyId'),
      wrappedDataKey: sql.placeholder('wrapped'),
      createdAt: sql.placeholder('now'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deleteVaultKeyRow = prepared((db, t) =>
  db.delete(t.vaultKey).where(inWorkspace(t.vaultKey, eq(t.vaultKey.id, 1))).prepare(),
)

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
const legacyAccounts = prepared((db, t) =>
  db
    .select({
      id: t.accounts.id,
      ownerUserId: t.accounts.ownerUserId,
      // Aliased: `users.id` would share the name `id` with `accounts.id`, and the
      // executor's named-row adapter collapses same-named columns (as in
      // `server-secrets.ts`), shifting every field after it.
      ownerId: sql<string | null>`${t.users.id}`.as('legacy_owner_id'),
      ownerDisabledAt: sql<string | null>`${t.users.disabledAt}`.as('legacy_owner_disabled_at'),
      accountKey: t.accounts.accountKey,
      ref: t.accounts.ref,
      provider: t.accounts.provider,
      kind: t.accounts.kind,
      credential: t.accounts.credential,
      sharedWith: t.accounts.sharedWith,
    })
    .from(t.accounts)
    .leftJoin(
      t.users,
      and(sameWorkspace(t.users, t.accounts), eq(t.users.id, t.accounts.ownerUserId)),
    )
    .where(inWorkspace(t.accounts))
    .orderBy(asc(t.accounts.createdAt), asc(t.accounts.id))
    .prepare(),
)

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
const legacySends = prepared((db, t) =>
  db
    .select({ accountId: t.accountMachineSends.accountId, machineId: t.accountMachineSends.machineId })
    .from(t.accountMachineSends)
    .where(inWorkspace(t.accountMachineSends))
    .prepare(),
)

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/** The three provider keys the server secrets held before credentials, by their old names. */
const legacyApiKeys = prepared((db, t) =>
  db
    .select({ key: t.workspaceSecrets.key, value: t.workspaceSecrets.value })
    .from(t.workspaceSecrets)
    .where(
      inWorkspace(
        t.workspaceSecrets,
        inArray(t.workspaceSecrets.key, ['apiKeys.anthropic', 'apiKeys.openai', 'apiKeys.openrouter']),
      ),
    )
    .prepare(),
)

const now = (): string => new Date().toISOString()

/** A new credential id: `cred_<uuid>`, minted by the server, meaning nothing by itself. */
export const newCredentialId = (): CredentialId =>
  asCredentialId(`${CREDENTIAL_ID_PREFIX}${randomUUID()}`)

export class CredentialsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  /**
   * One workspace's queries: its credentials, their secrets and its vault key are
   * that workspace's (POD-6959).
   * @param vault the workspace's vault, once its store has opened it (undefined before).
   */
  constructor(
    queries: WorkspaceQueries,
    private readonly vault: () => VaultKeyCheck | undefined,
  ) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db(): WorkspaceDb {
    return this.scope
  }

  /**
   * Insert a credential and its first secret (version 1) in one transaction. The
   * secret was sealed beforehand for `input.id`, so nothing inside waits on the key.
   */
  async insertWithSecret(
    input: NewCredential & { id: CredentialId },
    sealed: SealedSecret,
  ): Promise<CredentialRecord> {
    return await this.createOrJoinTransaction(async () => {
      const record = await this.insert(input)
      if ((await this.putSecret(input.id, sealed, 0)) !== 1) {
        throw new Error('a new credential already had a stored secret')
      }
      return record
    })
  }

  async insert(input: NewCredential): Promise<CredentialRecord> {
    const identity = input.identity ?? {}
    const [row] = await insertCredential(this.db).all({
      id: input.id ?? newCredentialId(),
      ownerUserId: input.ownerUserId,
      label: input.label,
      type: input.type,
      identity: JSON.stringify(identity),
      identityFingerprint: identity.fingerprint ?? null,
      expiresAt: input.expiresAt ?? null,
      legacyId: input.legacyId ?? null,
      legacyKey: input.legacyKey ?? null,
      now: now(),
    })
    if (!row) throw new Error('credential insert returned no row')
    return toRecord(row)
  }

  async get(id: CredentialId): Promise<CredentialRecord | undefined> {
    const row = await credentialById(this.db).get({ id })
    return row ? toRecord(row) : undefined
  }

  /**
   * The credentials this person may see, oldest first: today their own, not
   * removed. Shared credentials join this list with grants (epic Task 4).
   */
  async listVisibleTo(userId: UserId): Promise<CredentialRecord[]> {
    return (await credentialsOfOwner(this.db).all({ ownerUserId: userId })).map(toRecord)
  }

  /** Many credentials by id in one read per 500, removed ones left out. */
  async getMany(ids: readonly CredentialId[]): Promise<CredentialRecord[]> {
    const unique = [...new Set(ids)]
    const out: CredentialRecord[] = []
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      const rows = await credentialsByIds(this.db, size).all(inListValues(chunk, size, 'ids'))
      out.push(...rows.map(toRecord))
    }
    return out
  }

  /** The machines each credential's owner allowed (section 8); every asked id has an entry. */
  async allowedMachinesOf(ids: readonly CredentialId[]): Promise<Map<CredentialId, MachineId[]>> {
    const unique = [...new Set(ids)]
    const out = new Map<CredentialId, MachineId[]>(unique.map((id) => [id, []]))
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      const rows = await allowedMachinesOfMany(this.db, size).all(inListValues(chunk, size, 'ids'))
      for (const row of rows) out.get(asCredentialId(row.credentialId))?.push(row.machineId)
    }
    return out
  }

  async rename(id: CredentialId, label: string): Promise<void> {
    await renameCredential(this.db).run({ id, label, now: now() })
  }

  /** Replace what is known about the provider account (a renewed key has a new one). */
  async setIdentity(id: CredentialId, identity: CredentialIdentity): Promise<void> {
    await setCredentialIdentity(this.db).run({
      id,
      identity: JSON.stringify(identity),
      identityFingerprint: identity.fingerprint ?? null,
      now: now(),
    })
  }

  async setStatus(
    id: CredentialId,
    status: CredentialStatus,
    reason: string | null = null,
  ): Promise<void> {
    await setCredentialStatus(this.db).run({ id, status, statusReason: reason, now: now() })
  }

  /** It was shown to work at `at` (a provider accepted it). */
  async markVerified(id: CredentialId, at: string): Promise<void> {
    await markCredentialVerified(this.db).run({ id, at, now: now() })
  }

  async setExpiresAt(id: CredentialId, expiresAt: string | null): Promise<void> {
    await setCredentialExpiry(this.db).run({ id, expiresAt, now: now() })
  }

  /** The provider reported a plan or rate limit until `until`; null clears it. */
  async setLimitReachedUntil(id: CredentialId, until: string | null): Promise<void> {
    await setCredentialLimit(this.db).run({ id, until, now: now() })
  }

  /**
   * Move it to `attention` with `reason` if it is `ok` now. True only for the
   * call that moved it: a credential already needing attention, or removed, is
   * left as it is.
   */
  async markAttention(id: CredentialId, reason: string): Promise<boolean> {
    const moved = await markCredentialAttention(this.db).all({
      id,
      statusReason: reason,
      now: now(),
    })
    return moved.length > 0
  }

  /** Every credential with a recorded expiry, not removed, soonest first. */
  async listWithExpiry(): Promise<CredentialRecord[]> {
    return (await credentialsWithExpiry(this.db).all()).map(toRecord)
  }

  /** The owner's credential for one provider identity, not removed. */
  async findByIdentity(i: {
    ownerUserId: UserId
    type: string
    fingerprint: string
  }): Promise<CredentialRecord | undefined> {
    const row = await credentialByIdentity(this.db).get(i)
    return row ? toRecord(row) : undefined
  }

  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  async findByLegacyId(legacyId: string): Promise<CredentialRecord | undefined> {
    const row = await credentialByLegacyId(this.db).get({ legacyId })
    return row ? toRecord(row) : undefined
  }

  /** The owner's credential moved from the old account id `legacyKey` (`managed:anthropic`). */
  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  async findByLegacyKey(
    ownerUserId: UserId,
    legacyKey: string,
  ): Promise<CredentialRecord | undefined> {
    const row = await credentialByLegacyKey(this.db).get({ ownerUserId, legacyKey })
    return row ? toRecord(row) : undefined
  }

  // LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
  /**
   * Credentials of members other than `userId` that were moved from the old
   * account id `legacyKey` or `earlierKey`, not revoked, in the order the old
   * own-then-shared read took the shared ones. Whether `userId` may use each
   * is the caller's question (`mayUse`).
   */
  async legacySharedCandidates(i: {
    userId: UserId
    legacyKey: string
    earlierKey: string
  }): Promise<{ id: CredentialId; ownerUserId: UserId }[]> {
    return (await legacySharedCandidates(this.db).all(i)).map((r) => ({
      id: asCredentialId(r.id),
      ownerUserId: r.ownerUserId as UserId,
    }))
  }

  /** Delete the secrets; keep the record as `revoked`, which hides it from lists. */
  async remove(id: CredentialId): Promise<void> {
    await this.createOrJoinTransaction(async () => {
      await deleteSecretsOf(this.db).run({ credentialId: id })
      await setCredentialStatus(this.db).run({
        id,
        status: 'revoked',
        statusReason: 'removed',
        now: now(),
      })
    })
  }

  /**
   * Store a newly sealed secret as version `expectedVersion + 1`, only if the
   * newest stored version is still `expectedVersion` (0: none yet). Otherwise
   * `'conflict'`, and nothing changes. Older versions are deleted, so one secret
   * per credential is kept. The caller seals with the version it expects to get.
   */
  async putSecret(
    id: CredentialId,
    sealed: SealedSecret,
    expectedVersion: number,
  ): Promise<number | 'conflict'> {
    return await this.createOrJoinTransaction(async () => {
      const newest = await newestSecret(this.db).get({ credentialId: id })
      if ((newest?.version ?? 0) !== expectedVersion) return 'conflict'
      const version = expectedVersion + 1
      await insertSecret(this.db).run({
        credentialId: id,
        version,
        ciphertext: sealed.ciphertext.toString('base64'),
        nonce: sealed.nonce.toString('base64'),
        keyId: sealed.keyId,
        now: now(),
      })
      await deleteOlderSecrets(this.db).run({ credentialId: id, version })
      return version
    })
  }

  async latestSecret(id: CredentialId): Promise<LatestSecret | null> {
    const row = await newestSecret(this.db).get({ credentialId: id })
    if (!row) return null
    return {
      version: row.version,
      sealed: {
        ciphertext: Buffer.from(row.ciphertext, 'base64'),
        nonce: Buffer.from(row.nonce, 'base64'),
        keyId: row.keyId,
      },
      openable: this.vault()?.canOpen(row.keyId) ?? false,
    }
  }

  async recordPlacement(ref: PlacementRecord): Promise<void> {
    await upsertPlacement(this.db).run({
      credentialId: ref.credentialId,
      machineId: ref.machineId,
      kind: ref.kind,
      homeId: ref.homeId ?? null,
      now: now(),
    })
  }

  async listPlacements(id: CredentialId): Promise<Placement[]> {
    return (await placementsOf(this.db).all({ credentialId: id })).map(toPlacement)
  }

  /**
   * The owner's placements still on a machine (present or removal pending),
   * each with its credential, removed or not. One read.
   */
  async listLivePlacementsOfOwner(ownerUserId: UserId): Promise<
    {
      credential: CredentialRecord
      machineId: MachineId
      kind: PlacementKind
      homeId?: string
      state: Exclude<PlacementState, 'removed'>
    }[]
  > {
    return (await livePlacementsOfOwner(this.db).all({ ownerUserId })).map((r) => ({
      credential: toRecord(r.credential),
      machineId: r.machineId,
      kind: toPlacementKind(r.kind),
      ...(r.homeId ? { homeId: r.homeId } : {}),
      state: r.state === 'present' ? 'present' : 'removal-pending',
    }))
  }

  /** Placements on `machineId` still waiting for the machine to confirm their removal. */
  async listPendingPlacementsOn(machineId: MachineId): Promise<Placement[]> {
    return (await pendingPlacementsOn(this.db).all({ machineId })).map(toPlacement)
  }

  async setPlacementState(ref: PlacementRef, state: PlacementState): Promise<void> {
    await setPlacement(this.db).run({
      credentialId: ref.credentialId,
      machineId: ref.machineId,
      kind: ref.kind,
      state,
      removedAt: state === 'removed' ? now() : null,
    })
  }

  async allowMachine(id: CredentialId, machineId: MachineId, allowedBy: UserId): Promise<void> {
    await insertAllowedMachine(this.db).run({
      credentialId: id,
      machineId,
      allowedBy,
      now: now(),
    })
  }

  async disallowMachine(id: CredentialId, machineId: MachineId): Promise<void> {
    await deleteAllowedMachine(this.db).run({ credentialId: id, machineId })
  }

  async isMachineAllowed(id: CredentialId, machineId: MachineId): Promise<boolean> {
    return (await allowedMachine(this.db).get({ credentialId: id, machineId })) !== undefined
  }

  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  /** Every `accounts` row, oldest first, for the one-time move. Holds secrets. */
  async legacyAccountRows(): Promise<LegacyAccountRow[]> {
    return (await legacyAccounts(this.db).all()).map((r) => ({
      id: r.id,
      ownerUserId: r.ownerUserId ?? null,
      ownerLive: r.ownerId !== null && r.ownerDisabledAt === null,
      accountKey: r.accountKey ?? null,
      ref: r.ref ?? null,
      provider: r.provider,
      kind: r.kind,
      credential: r.credential,
      sharedWith: parseLegacySharedWith(r.sharedWith ?? null),
    }))
  }

  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  /** Every machine an old account was sent to, by `accounts.id`. */
  async legacyApiKeySecrets(): Promise<{ key: string; value: string }[]> {
    return await legacyApiKeys(this.db).all()
  }

  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  async legacyAccountSends(): Promise<{ accountId: string; machineId: MachineId }[]> {
    return await legacySends(this.db).all()
  }

  // The vault's own row. Only `Vault` calls these.

  async readVaultKey(): Promise<StoredVaultKey | null> {
    const row = await theVaultKey(this.db).get()
    return row ? { keyId: row.keyId, wrapped: Buffer.from(row.wrappedDataKey, 'base64') } : null
  }

  /** Store the wrapped data key unless one is already there; the stored one wins. */
  async insertVaultKeyIfAbsent(keyId: string, wrapped: Buffer): Promise<void> {
    await insertVaultKey(this.db).run({ keyId, wrapped: wrapped.toString('base64'), now: now() })
  }

  /**
   * Vault reset: delete the wrapped data key and every sealed secret, and mark
   * each credential that had one as needing attention. Returns those credentials.
   */
  async deleteVaultKeyAndSecrets(reason: string): Promise<CredentialId[]> {
    return await this.createOrJoinTransaction(async () => {
      const affected = await markSealedCredentialsForAttention(this.db).all({
        statusReason: reason,
        now: now(),
      })
      await deleteAllSecrets(this.db).run()
      await deleteVaultKeyRow(this.db).run()
      return affected.map((r) => asCredentialId(r.id))
    })
  }
}
