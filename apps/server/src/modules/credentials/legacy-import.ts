// LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
/**
 * THE ONE-TIME MOVE OF THE KEYS PODIUM STORED BEFORE THE VAULT (design §18).
 *
 * Two old stores held provider keys in plain text: the `accounts` table (one row
 * per person and account id) and the `apiKeys.*` server secrets. At every start,
 * each one that is not yet a credential becomes one, with its secret sealed by the
 * vault and its old id in `legacy_id`:
 *
 *  - an `accounts` API-key row of anthropic, openai or openrouter becomes
 *    `<provider>.api-key`; the Anthropic `oauth` row (`managed:claude-oauth`, a
 *    Claude setup token) becomes `anthropic.claude-token`. Each keeps its owner;
 *    a row with no live owner goes to the first admin.
 *    Its `legacy_id` is the row's storage id; its `legacy_key` the account id
 *    sessions and settings recorded (`account_key`, else `ref`, else `id`).
 *  - an `apiKeys.<provider>` secret becomes `<provider>.api-key` owned by the
 *    first admin, unless the first admin already has the same key in `accounts`:
 *    the same secret in both stores is one credential. Its `legacy_id` is the key;
 *    its `legacy_key` is `managed:<provider>` unless an `accounts` row of the first
 *    admin already answers that id.
 *
 * The same secret of the same type for the same owner is one credential. Its
 * sharing and sends come with it, once, in the start that creates it: each user
 * id in `accounts.shared_with` becomes a `use` grant to that person, `*` a `use`
 * grant to all members (a user id that no longer exists is skipped and logged),
 * and each `account_machine_sends` row allows that machine (`credential_machines`,
 * allowed by the credential's owner). They are not carried again at a later
 * start, so an unshare or a disallowed machine stays that way; the old
 * `accounts.*` commands write their changes through to the credential instead.
 * A row with no credential type is skipped and logged by its id, provider and
 * kind, never its value.
 *
 * The old values are left where they are; epic Task 21 destroys them once every
 * moved secret has been read back. Nothing is imported while the vault cannot
 * seal (a locked vault, an unusable key file): the next start with the key does it.
 */

import { createLogger } from '@podium/logger'
import {
  ALL_MEMBERS_GRANTEE,
  type CredentialId,
  type CredentialTypeId,
  type UserId,
} from '@podium/model'
import {
  type CredentialsRepository,
  type LegacyAccountRow,
  newCredentialId,
} from '../../store/credentials'
import type { GrantsRepository } from '../../store/grants'
import type { ServerSecretsRepository } from '../../store/server-secrets'
import type { UsersRepository } from '../../store/users'
import { type Vault, VaultLockedError, withSecret } from './vault'

const moduleLog = createLogger('server:credentials')

export interface LegacyImportDeps {
  secrets: Pick<ServerSecretsRepository, 'get'>
  users: Pick<UsersRepository, 'earliestAdmin' | 'get'>
  credentials: CredentialsRepository
  grants: Pick<GrantsRepository, 'upsert'>
  vault: Vault
  /** Defaults to the server log. */
  log?: {
    info(message: string, fields: Record<string, unknown>): void
    warn(message: string, fields: Record<string, unknown>): void
  }
}

export interface LegacyImportResult {
  created: number
  /** Machines allowed from the old sends, new this start. */
  machinesAllowed: number
  /** Grants made from the old sharing, new this start. */
  grantsMade: number
  /** Old rows not moved, by id, provider and kind (never the value). */
  skipped: string[]
  /** Why nothing was imported this start, or null. */
  refused: 'vault-locked' | 'vault-key-unusable' | null
}

const API_KEY_TYPES: Readonly<Record<string, CredentialTypeId>> = {
  anthropic: 'anthropic.api-key',
  openai: 'openai.api-key',
  openrouter: 'openrouter.api-key',
}

export const TYPE_LABELS: Readonly<Partial<Record<CredentialTypeId, string>>> = {
  'anthropic.api-key': 'Anthropic API key',
  'openai.api-key': 'OpenAI API key',
  'openrouter.api-key': 'OpenRouter API key',
  'anthropic.claude-token': 'Claude token',
}

const LEGACY_API_KEY_SECRETS = [
  'apiKeys.anthropic',
  'apiKeys.openai',
  'apiKeys.openrouter',
] as const

interface Candidate {
  legacyId: string
  /** The id sessions and settings recorded; null when another credential of the
   *  same owner already answers it. */
  legacyKey: string | null
  ownerUserId: UserId
  type: CredentialTypeId
  label: string
  secret: string
  /** `accounts.shared_with` of the row, or [] (the `apiKeys.*` secrets were never shared). */
  sharedWith: readonly string[]
}

/** The credential type an `accounts` row maps to, or undefined when it has none. */
export function legacyAccountType(row: {
  provider: string
  kind: string
}): CredentialTypeId | undefined {
  if (row.kind === 'oauth')
    return row.provider === 'anthropic' ? 'anthropic.claude-token' : undefined
  if (row.kind !== 'api-key') return undefined
  return API_KEY_TYPES[row.provider]
}

interface Plan {
  /** One per credential to have, in the order they are created. */
  kept: Candidate[]
  /** Every old row and secret, merged ones included. */
  sources: Candidate[]
  /** A merged-away source's legacy id → the legacy id of the credential it became. */
  mergedInto: Map<string, string>
  skipped: string[]
}

/**
 * Decide what the old stores become. Rows whose owner is live come first, so their
 * own account ids are theirs; then rows with no live owner (moved to the first
 * admin); then the `apiKeys.*` secrets (the first admin's). The same secret of the
 * same type for the same owner is one credential, the first one met.
 */
async function plan(deps: LegacyImportDeps): Promise<Plan> {
  const admin = await deps.users.earliestAdmin()
  const adminId = admin ? (admin.id as UserId) : undefined
  const skipped: string[] = []
  const rows = await deps.credentials.legacyAccountRows()
  const ordered = [...rows.filter((r) => r.ownerLive), ...rows.filter((r) => !r.ownerLive)]
  const sources: Candidate[] = []
  for (const row of ordered) {
    const candidate = fromAccount(row, adminId)
    if (typeof candidate === 'string') skipped.push(candidate)
    else if (candidate) sources.push(candidate)
  }
  if (adminId) {
    for (const key of LEGACY_API_KEY_SECRETS) {
      const secret = await deps.secrets.get(key)
      if (!secret) continue
      const provider = key.slice('apiKeys.'.length)
      const type = API_KEY_TYPES[provider] as CredentialTypeId
      sources.push({
        legacyId: key,
        legacyKey: `managed:${provider}`,
        ownerUserId: adminId,
        type,
        label: `${TYPE_LABELS[type]} (workspace)`,
        secret,
        sharedWith: [],
      })
    }
  }

  const kept: Candidate[] = []
  const mergedInto = new Map<string, string>()
  const claimedKeys = new Set<string>()
  for (const source of sources) {
    const same = kept.find(
      (k) =>
        k.ownerUserId === source.ownerUserId &&
        k.type === source.type &&
        k.secret === source.secret,
    )
    if (same) {
      mergedInto.set(source.legacyId, same.legacyId)
      continue
    }
    const claim = source.legacyKey ? `${source.ownerUserId}\0${source.legacyKey}` : null
    if (claim && claimedKeys.has(claim)) source.legacyKey = null
    else if (claim) claimedKeys.add(claim)
    kept.push(source)
  }
  return { kept, mergedInto, skipped, sources }
}

function fromAccount(
  row: LegacyAccountRow,
  adminId: UserId | undefined,
): Candidate | string | undefined {
  const type = legacyAccountType(row)
  if (!type) return `${row.id} (${row.provider}/${row.kind})`
  if (row.credential === '') return undefined
  const owner = row.ownerLive && row.ownerUserId ? row.ownerUserId : adminId
  if (!owner) return `${row.id} (no owner, and no admin to take it)`
  const legacyKey = row.accountKey ?? row.ref ?? row.id
  const earlier = legacyKey.endsWith(':earlier-workspace')
  return {
    legacyId: row.id,
    legacyKey,
    ownerUserId: owner,
    type,
    label: `${TYPE_LABELS[type]}${earlier ? ' (earlier workspace)' : ''}`,
    secret: row.credential,
    sharedWith: row.sharedWith,
  }
}

type Created = ReadonlyMap<string, { id: CredentialId; ownerUserId: UserId }>

/** Allow each credential made this start on the machines its old key was sent to. */
async function carrySends(
  deps: LegacyImportDeps,
  created: Created,
  mergedInto: ReadonlyMap<string, string>,
): Promise<number> {
  let allowed = 0
  for (const send of await deps.credentials.legacyAccountSends()) {
    const credential = created.get(mergedInto.get(send.accountId) ?? send.accountId)
    if (!credential) continue
    if (await deps.credentials.isMachineAllowed(credential.id, send.machineId)) continue
    await deps.credentials.allowMachine(credential.id, send.machineId, credential.ownerUserId)
    allowed += 1
  }
  return allowed
}

/**
 * Give `use` of each credential made this start to whoever its old rows were
 * shared with: `*` is all members, anything else a person who must still exist.
 */
async function carryShares(
  deps: LegacyImportDeps,
  created: Created,
  sources: readonly Candidate[],
  mergedInto: ReadonlyMap<string, string>,
  log: NonNullable<LegacyImportDeps['log']>,
): Promise<number> {
  let made = 0
  const vanished: string[] = []
  for (const source of sources) {
    const credential = created.get(mergedInto.get(source.legacyId) ?? source.legacyId)
    if (!credential) continue
    for (const shared of new Set(source.sharedWith)) {
      if (shared === credential.ownerUserId) continue
      if (shared !== '*' && !(await deps.users.get(shared as UserId))) {
        vanished.push(`${source.legacyId} → ${shared}`)
        continue
      }
      await deps.grants.upsert({
        resourceKind: 'credential',
        resourceId: credential.id,
        grantee: shared === '*' ? ALL_MEMBERS_GRANTEE : shared,
        verb: 'use',
        owner: credential.ownerUserId,
        visibility: 'secret',
        createdAt: new Date().toISOString(),
        actorKind: 'system',
        actorId: null,
        onBehalfOf: credential.ownerUserId,
      })
      made += 1
    }
  }
  if (vanished.length > 0) {
    log.info('old shares with people who no longer exist were not carried over', { vanished })
  }
  return made
}

export async function importLegacyCredentials(deps: LegacyImportDeps): Promise<LegacyImportResult> {
  const log = deps.log ?? moduleLog
  if (deps.vault.state() === 'locked') {
    return {
      created: 0,
      machinesAllowed: 0,
      grantsMade: 0,
      skipped: [],
      refused: 'vault-locked',
    }
  }
  const { kept, mergedInto, skipped, sources } = await plan(deps)
  if (skipped.length > 0) {
    log.info('old account rows without a credential type were not moved into the vault', {
      skipped,
    })
  }
  // Only the credentials made in this start carry their old sharing and sends.
  const createdNow = new Map<string, { id: CredentialId; ownerUserId: UserId }>()
  let created = 0
  let refused: LegacyImportResult['refused'] = null
  for (const candidate of kept) {
    if (await deps.credentials.findByLegacyId(candidate.legacyId)) continue
    const id = newCredentialId()
    let sealed: Awaited<ReturnType<Vault['seal']>>
    try {
      sealed = await deps.vault.seal(
        { credentialId: id, type: candidate.type, version: 1 },
        Buffer.from(candidate.secret, 'utf8'),
      )
    } catch (error) {
      if (!(error instanceof VaultLockedError)) throw error
      log.warn('old keys were not moved into the vault: its key cannot be used', {
        problem: deps.vault.status().problem,
      })
      refused = 'vault-key-unusable'
      break
    }
    // A key an earlier credential of this owner already answers stays unclaimed.
    const legacyKey =
      candidate.legacyKey &&
      !(await deps.credentials.findByLegacyKey(candidate.ownerUserId, candidate.legacyKey))
        ? candidate.legacyKey
        : null
    await deps.credentials.insertWithSecret(
      {
        id,
        ownerUserId: candidate.ownerUserId,
        label: candidate.label,
        type: candidate.type,
        legacyId: candidate.legacyId,
        legacyKey,
      },
      sealed,
    )
    const readBack = await withSecret(deps, id, async (secret) => secret === candidate.secret)
    if (!readBack) throw new Error(`moving ${candidate.legacyId} into the vault did not read back`)
    createdNow.set(candidate.legacyId, { id, ownerUserId: candidate.ownerUserId })
    created += 1
  }
  const machinesAllowed = await carrySends(deps, createdNow, mergedInto)
  const grantsMade = await carryShares(deps, createdNow, sources, mergedInto, log)
  if (created > 0 || machinesAllowed > 0 || grantsMade > 0) {
    log.info('moved old keys into the vault', { created, machinesAllowed, grantsMade })
  }
  return { created, machinesAllowed, grantsMade, skipped, refused }
}
