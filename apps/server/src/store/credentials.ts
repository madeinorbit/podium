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

import type { MachineId, UserId } from '@podium/model'
import { and, asc, desc, eq, lt, ne, sql } from 'drizzle-orm'
import {
  accountMachineSends,
  accounts,
  credentialMachines,
  credentialPlacements,
  credentialSecrets,
  credentials,
  users,
  vaultKey,
} from '../migrations/schema'
import {
  asCredentialId,
  type CredentialId,
  newCredentialId,
} from '../modules/credentials/credential-id'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import { param, prepared } from './executor/sync-drizzle'

export type CredentialStatus = 'ok' | 'attention' | 'revoked'

/** Who a credential is at its provider. Never a secret. */
export interface CredentialIdentity {
  fingerprint?: string
  email?: string
  plan?: string
  organisation?: string
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

export interface Placement extends PlacementRef {
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
}

export interface StoredVaultKey {
  keyId: string
  wrapped: Buffer
}

type CredentialRow = typeof credentials.$inferSelect

function parseIdentity(raw: string): CredentialIdentity {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: CredentialIdentity = {}
    for (const key of ['fingerprint', 'email', 'plan', 'organisation'] as const) {
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

// Every query this repository runs, prepared once per store [POD-6147].

const idIs = () => eq(credentials.id, param(credentials.id, 'id'))

const credentialById = prepared((db: StoreDrizzle) =>
  db.select().from(credentials).where(idIs()).prepare(),
)

const credentialsOfOwner = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.ownerUserId, param(credentials.ownerUserId, 'ownerUserId')),
        ne(credentials.status, 'revoked'),
      ),
    )
    .orderBy(asc(credentials.createdAt), asc(credentials.id))
    .prepare(),
)

const credentialByLegacyId = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(credentials)
    .where(eq(credentials.legacyId, param(credentials.legacyId, 'legacyId')))
    .prepare(),
)

const credentialByLegacyKey = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.ownerUserId, param(credentials.ownerUserId, 'ownerUserId')),
        eq(credentials.legacyKey, param(credentials.legacyKey, 'legacyKey')),
      ),
    )
    .prepare(),
)

const credentialByIdentity = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.ownerUserId, param(credentials.ownerUserId, 'ownerUserId')),
        eq(credentials.type, param(credentials.type, 'type')),
        eq(credentials.identityFingerprint, param(credentials.identityFingerprint, 'fingerprint')),
        ne(credentials.status, 'revoked'),
      ),
    )
    .limit(1)
    .prepare(),
)

const insertCredential = prepared((db: StoreDrizzle) =>
  db
    .insert(credentials)
    .values({
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

const renameCredential = prepared((db: StoreDrizzle) =>
  db
    .update(credentials)
    .set({ label: sql.placeholder('label'), updatedAt: sql.placeholder('now') })
    .where(idIs())
    .prepare(),
)

const setCredentialStatus = prepared((db: StoreDrizzle) =>
  db
    .update(credentials)
    .set({
      status: sql.placeholder('status'),
      statusReason: sql.placeholder('statusReason'),
      updatedAt: sql.placeholder('now'),
    })
    .where(idIs())
    .prepare(),
)

const secretIs = () =>
  eq(credentialSecrets.credentialId, param(credentialSecrets.credentialId, 'credentialId'))

const newestSecret = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(credentialSecrets)
    .where(secretIs())
    .orderBy(desc(credentialSecrets.version))
    .limit(1)
    .prepare(),
)

const insertSecret = prepared((db: StoreDrizzle) =>
  db
    .insert(credentialSecrets)
    .values({
      credentialId: sql.placeholder('credentialId'),
      version: sql.placeholder('version'),
      ciphertext: sql.placeholder('ciphertext'),
      nonce: sql.placeholder('nonce'),
      keyId: sql.placeholder('keyId'),
      createdAt: sql.placeholder('now'),
    })
    .prepare(),
)

const deleteOlderSecrets = prepared((db: StoreDrizzle) =>
  db
    .delete(credentialSecrets)
    .where(
      and(secretIs(), lt(credentialSecrets.version, param(credentialSecrets.version, 'version'))),
    )
    .prepare(),
)

const deleteSecretsOf = prepared((db: StoreDrizzle) =>
  db.delete(credentialSecrets).where(secretIs()).prepare(),
)

/** Vault reset: every credential that has a sealed secret needs attention. */
const markSealedCredentialsForAttention = prepared((db: StoreDrizzle) =>
  db
    .update(credentials)
    .set({
      status: 'attention',
      statusReason: sql.placeholder('statusReason'),
      updatedAt: sql.placeholder('now'),
    })
    .where(
      and(
        ne(credentials.status, 'revoked'),
        sql`${credentials.id} IN (SELECT ${credentialSecrets.credentialId} FROM ${credentialSecrets})`,
      ),
    )
    .returning({ id: credentials.id })
    .prepare(),
)

const deleteAllSecrets = prepared((db: StoreDrizzle) => db.delete(credentialSecrets).prepare())

const placementIs = () =>
  and(
    eq(credentialPlacements.credentialId, param(credentialPlacements.credentialId, 'credentialId')),
    eq(credentialPlacements.machineId, param(credentialPlacements.machineId, 'machineId')),
    eq(credentialPlacements.kind, param(credentialPlacements.kind, 'kind')),
  )

const upsertPlacement = prepared((db: StoreDrizzle) =>
  db
    .insert(credentialPlacements)
    .values({
      credentialId: sql.placeholder('credentialId'),
      machineId: sql.placeholder('machineId'),
      kind: sql.placeholder('kind'),
      state: 'present',
      createdAt: sql.placeholder('now'),
    })
    .onConflictDoUpdate({
      target: [
        credentialPlacements.credentialId,
        credentialPlacements.machineId,
        credentialPlacements.kind,
      ],
      set: { state: 'present', removedAt: null },
    })
    .prepare(),
)

const placementsOf = prepared((db: StoreDrizzle) =>
  db
    .select()
    .from(credentialPlacements)
    .where(
      eq(
        credentialPlacements.credentialId,
        param(credentialPlacements.credentialId, 'credentialId'),
      ),
    )
    .prepare(),
)

const setPlacement = prepared((db: StoreDrizzle) =>
  db
    .update(credentialPlacements)
    .set({ state: sql.placeholder('state'), removedAt: sql.placeholder('removedAt') })
    .where(placementIs())
    .prepare(),
)

const machineIs = () =>
  and(
    eq(credentialMachines.credentialId, param(credentialMachines.credentialId, 'credentialId')),
    eq(credentialMachines.machineId, param(credentialMachines.machineId, 'machineId')),
  )

const insertAllowedMachine = prepared((db: StoreDrizzle) =>
  db
    .insert(credentialMachines)
    .values({
      credentialId: sql.placeholder('credentialId'),
      machineId: sql.placeholder('machineId'),
      allowedBy: sql.placeholder('allowedBy'),
      createdAt: sql.placeholder('now'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deleteAllowedMachine = prepared((db: StoreDrizzle) =>
  db.delete(credentialMachines).where(machineIs()).prepare(),
)

const allowedMachine = prepared((db: StoreDrizzle) =>
  db
    .select({ credentialId: credentialMachines.credentialId })
    .from(credentialMachines)
    .where(machineIs())
    .prepare(),
)

const theVaultKey = prepared((db: StoreDrizzle) =>
  db.select().from(vaultKey).where(eq(vaultKey.id, 1)).prepare(),
)

const insertVaultKey = prepared((db: StoreDrizzle) =>
  db
    .insert(vaultKey)
    .values({
      id: 1,
      keyId: sql.placeholder('keyId'),
      wrappedDataKey: sql.placeholder('wrapped'),
      createdAt: sql.placeholder('now'),
    })
    .onConflictDoNothing()
    .prepare(),
)

const deleteVaultKeyRow = prepared((db: StoreDrizzle) =>
  db.delete(vaultKey).where(eq(vaultKey.id, 1)).prepare(),
)

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
const legacyAccounts = prepared((db: StoreDrizzle) =>
  db
    .select({
      id: accounts.id,
      ownerUserId: accounts.ownerUserId,
      // Aliased: `users.id` would share the name `id` with `accounts.id`, and the
      // executor's named-row adapter collapses same-named columns (as in
      // `server-secrets.ts`), shifting every field after it.
      ownerId: sql<string | null>`${users.id}`.as('legacy_owner_id'),
      ownerDisabledAt: sql<string | null>`${users.disabledAt}`.as('legacy_owner_disabled_at'),
      accountKey: accounts.accountKey,
      ref: accounts.ref,
      provider: accounts.provider,
      kind: accounts.kind,
      credential: accounts.credential,
    })
    .from(accounts)
    .leftJoin(users, eq(users.id, accounts.ownerUserId))
    .orderBy(asc(accounts.createdAt), asc(accounts.id))
    .prepare(),
)

// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
const legacySends = prepared((db: StoreDrizzle) =>
  db
    .select({ accountId: accountMachineSends.accountId, machineId: accountMachineSends.machineId })
    .from(accountMachineSends)
    .prepare(),
)

const now = (): string => new Date().toISOString()

export class CredentialsRepository {
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  /** @param vault the vault, once the store has opened it (undefined before). */
  constructor(
    queries: StoreQueries,
    private readonly vault: () => VaultKeyCheck | undefined,
  ) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  /** The query builder, resolved on every access so B1 changes this line and nothing else
   *  [POD-3221 spec rule 34a]. */
  protected get db() {
    return this.rootDb
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

  async rename(id: CredentialId, label: string): Promise<void> {
    await renameCredential(this.db).run({ id, label, now: now() })
  }

  async setStatus(
    id: CredentialId,
    status: CredentialStatus,
    reason: string | null = null,
  ): Promise<void> {
    await setCredentialStatus(this.db).run({ id, status, statusReason: reason, now: now() })
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

  async recordPlacement(ref: PlacementRef): Promise<void> {
    await upsertPlacement(this.db).run({ ...ref, now: now() })
  }

  async listPlacements(id: CredentialId): Promise<Placement[]> {
    return (await placementsOf(this.db).all({ credentialId: id })).map((r) => ({
      credentialId: asCredentialId(r.credentialId),
      machineId: r.machineId,
      kind: toPlacementKind(r.kind),
      state: toPlacementState(r.state),
      createdAt: r.createdAt,
      removedAt: r.removedAt,
    }))
  }

  async setPlacementState(ref: PlacementRef, state: PlacementState): Promise<void> {
    await setPlacement(this.db).run({
      ...ref,
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
    }))
  }

  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  /** Every machine an old account was sent to, by `accounts.id`. */
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
