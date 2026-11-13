/** Spawn companions shared by new sessions and revival: subagent model, theme
 * seed, and the credential a launch runs on. Model/effort belong to the launch
 * resolver. */

import { harnessAccepts } from '@podium/harness/metadata'
import {
  type AgentKind,
  CREDENTIAL_ID_PREFIX,
  type CredentialId,
  type MachineId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { harnessCapabilitiesFor } from '../../harness-manifest'
import type { SessionStore } from '../../store'
import {
  type AccessRefusal,
  type AccessRefused,
  refuse,
  resolveSessionAccess,
} from '../credentials/access'
import { credentialIdFromLegacy } from '../credentials/legacy-ids'
import { SecretUnavailableError, withSecret } from '../credentials/vault'

export interface LaunchConfigPorts {
  store: Pick<
    SessionStore,
    'settings' | 'credentials' | 'machines' | 'settingsAudit' | 'grants' | 'vault'
  >
}

export interface LaunchModelDefaults {
  subagentModel?: string
  seedCliTheme?: boolean
}

/**
 * What a launch may run on: the credential and, for an `env` delivery, the
 * variable carrying its secret, ready for the spawn frame. Or the refusal.
 */
export type LaunchAccess =
  | { ok: true; credentialId: CredentialId | null; env?: Record<string, string> }
  | AccessRefused

/** A launch refused for its credential. The message is the sentence a person reads. */
export class CredentialRefusal extends Error {
  override readonly name = 'CredentialRefusal'

  constructor(
    readonly refusal: AccessRefusal,
    message: string,
  ) {
    super(message)
  }
}

/** Why the vault could not hand over a secret, as the refusal a person reads. */
const SECRET_REFUSAL: Record<SecretUnavailableError['reason'], AccessRefusal> = {
  'not-found': 'not-found',
  revoked: 'revoked',
  'no-secret': 'needs-attention',
  'needs-attention': 'needs-attention',
}

// LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
/**
 * A role account from before credentials, as a default for this harness. The
 * role was shared by every harness, so an id this harness does not accept
 * (another harness's login, a key it cannot take) means no default here
 * rather than a refusal, as it meant before. A stored key the id names that
 * no longer exists is `'missing'`: the old launch refused it, and so does this
 * one, rather than run on the machine's own login.
 */
export async function legacyRoleDefault(
  store: Pick<SessionStore, 'credentials'>,
  harness: AgentKind,
  accountId: string,
  owner: UserId,
): Promise<CredentialId | null | 'missing'> {
  const id = await credentialIdFromLegacy(store, accountId, owner)
  if (!id) return accountId === '' || accountId.startsWith('native:') ? null : 'missing'
  const type = (await store.credentials.get(id))?.type
  return harnessAccepts(harness).some((line) => line.type === type) ? id : null
}

/** The credential a launch chose, or why it cannot run. */
export type CredentialChoice = { ok: true; credentialId: CredentialId | null } | AccessRefused

export class SessionLaunchConfig {
  constructor(private readonly ports: LaunchConfigPorts) {}

  /** Companions only, from the preferences of `owner`, the person the session
   *  runs for (POD-6285): Bob's spawn uses Bob's choices, never Alice's. */
  async modelDefaults(agentKind: AgentKind, owner: UserId): Promise<LaunchModelDefaults> {
    const settings = await this.ports.store.settings.getSettingsFor(owner)
    const coding = settings.roles.coding
    const subagentModel = coding.subagentModel
    return {
      ...(subagentModel !== 'auto' && harnessCapabilitiesFor(agentKind)?.subagentModelEnv
        ? { subagentModel }
        : {}),
      // Per-session CLI theme seeding rides every (re)spawn so a resurrected
      // session keeps the configured behaviour too [spec:SP-a04d].
      ...(agentKind !== 'shell' ? { seedCliTheme: coding.seedCliTheme } : {}),
    }
  }

  /**
   * The credential a new launch runs on (credential management §9 "Choosing
   * for a session"): the one the launch named (`null`: none), then the owner's
   * default for this harness, then none.
   */
  async selectCredential(i: {
    harness: AgentKind
    named?: CredentialId | null
    owner: UserId
    machineId: MachineId
  }): Promise<CredentialChoice> {
    if (i.named !== undefined) return { ok: true, credentialId: i.named }
    if (i.harness === 'shell') return { ok: true, credentialId: null }
    const settings = await this.ports.store.settings.getSettingsFor(i.owner)
    const chosen = settings.credentialDefaults[i.harness]
    if (chosen) return { ok: true, credentialId: chosen }
    return await this.legacyChoice(
      i.harness,
      resolveRole(settings, 'coding').accountId,
      i.owner,
      i.machineId,
    )
  }

  // LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
  private async legacyChoice(
    harness: AgentKind,
    accountId: string,
    owner: UserId,
    machineId: MachineId,
    sessionId?: SessionId,
  ): Promise<CredentialChoice> {
    const id = await legacyRoleDefault(this.ports.store, harness, accountId, owner)
    if (id !== 'missing') return { ok: true, credentialId: id }
    return await refuse(this.ports.store, 'not-found', {
      credentialId: null,
      actingUserId: owner,
      machineId,
      ...(sessionId ? { sessionId } : {}),
    })
  }

  // LEGACY(remove-after: 2027-02): reads account ids written before credentials existed; removing it stops old spellings from resolving
  /**
   * The credential a stored session runs on: its `credentialId`, else the
   * account id it was launched with before credentials existed. That id was
   * copied from the role shared by every harness, so it reads as the role did
   * (`legacyRoleDefault`): one this harness cannot take means none, as it did
   * when the session last ran. A credential id in that field passes through
   * (a headless turn's fence id), and the resolver says whether it fits.
   */
  async storedCredential(session: {
    harness: AgentKind
    credentialId?: CredentialId | undefined
    accountId?: string | undefined
    ownerUserId: UserId
    machineId: MachineId
    sessionId?: SessionId
  }): Promise<CredentialChoice> {
    if (session.credentialId) return { ok: true, credentialId: session.credentialId }
    if (!session.accountId) return { ok: true, credentialId: null }
    if (session.accountId.startsWith(CREDENTIAL_ID_PREFIX)) {
      return { ok: true, credentialId: session.accountId as CredentialId }
    }
    return await this.legacyChoice(
      session.harness,
      session.accountId,
      session.ownerUserId,
      session.machineId,
      session.sessionId,
    )
  }

  /**
   * Resolve `credentialId` for this launch and, for an `env` delivery, read
   * its secret into the variable the harness declared. Until the `access`
   * field exists (epic Task 5) the secret rides the spawn frame's `env`; this
   * is the last step before that frame is sent. A shell pane gets no
   * credential and no check: it is a prompt the person drives, not a harness.
   */
  async access(i: {
    harness: AgentKind
    driverId?: string
    credentialId: CredentialId | null
    owner: UserId
    machineId: MachineId
    sessionId?: SessionId
  }): Promise<LaunchAccess> {
    if (i.harness === 'shell') return { ok: true, credentialId: null }
    const plan = await resolveSessionAccess(this.ports.store, {
      harness: i.harness,
      ...(i.driverId !== undefined ? { driverId: i.driverId } : {}),
      credentialId: i.credentialId,
      actingUserId: i.owner,
      machineId: i.machineId,
      ...(i.sessionId ? { sessionId: i.sessionId } : {}),
    })
    if (!plan.ok) return plan
    if (plan.delivery.kind !== 'env' || plan.credentialId === null) {
      return { ok: true, credentialId: plan.credentialId }
    }
    const { variable } = plan.delivery
    const credentialId = plan.credentialId
    try {
      const env = await withSecret(this.ports.store, credentialId, async (secret) => ({
        [variable]: secret,
      }))
      return { ok: true, credentialId, env }
    } catch (error) {
      if (!(error instanceof SecretUnavailableError)) throw error
      return await refuse(this.ports.store, SECRET_REFUSAL[error.reason], {
        credentialId,
        actingUserId: i.owner,
        machineId: i.machineId,
        ...(i.sessionId ? { sessionId: i.sessionId } : {}),
      })
    }
  }
}
