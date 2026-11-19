import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asUserId, firstAdminMemberId } from '@podium/model'
import type { SyncKindTokens } from '@podium/protocol'
import { hashPassword } from '@podium/runtime/auth-store'
import { loadSupervisorState } from '@podium/runtime/machine-supervisor'
import {
  confirmSetupEnrollment,
  prepareSetupEnrollment,
  signMachineHello,
} from '@podium/runtime/setup-enrollment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptLegacyHostMachine,
  completePreauthorizedSetup,
  enrollSetupMachine,
  readSetupEnrollment,
} from './setup-enrollment'
import { SessionStore } from './store'
import { memberFacts } from './store/fixtures/test-support'
import { readKindTokens } from './sync/kind-tokens'
import { openTestStore } from './test-support/open-test-store'
import { testStoreEngine } from './test-support/pg-test-database'
import { seedRows } from './test-support/seed-rows'
import { openTestIdentity } from './test-support/test-identity'
import { promoteMachineAssignment } from './transfer-machine-assignment'

const actor = asUserId('setup-admin')
const stores: SessionStore[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function fixture(preauthorized = false, createActor = true) {
  const dir = mkdtempSync(join(tmpdir(), 'podium-setup-enrollment-'))
  dirs.push(dir)
  const store = await openTestStore(':memory:')
  stores.push(store)
  if (createActor)
    await memberFacts(store).create(
      {
        id: actor,
        displayName: 'Setup admin',
        role: 'admin',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'hash',
    )
  return { store, dir, request: prepareSetupEnrollment(true, preauthorized, dir) }
}

describe('setup enrollment transaction', () => {
  it('replays the same confirmation after commit but before parent credential confirmation', async () => {
    const { store, dir, request } = await fixture()
    expect(await store.machines.getMachine(asMachineId(request.machineId))).toBeUndefined()
    const first = await enrollSetupMachine(store, 'installation-a', request, actor)
    expect(loadSupervisorState(dir).enrolledPublicKey).toBeUndefined()
    const retry = prepareSetupEnrollment(true, false, dir)
    expect(retry).toEqual(request)
    expect(await enrollSetupMachine(store, 'installation-a', retry, actor)).toEqual(first)
    confirmSetupEnrollment(retry.requestId, first.publicKey, dir)
    expect(loadSupervisorState(dir).enrolledPublicKey).toBe(first.publicKey)
    expect(await store.machines.custodian(request.machineId)).toBe(actor)
  })

  it('rolls back the row and receipt together and retries with the original key', async () => {
    const { store, request } = await fixture()
    const failure = vi
      .spyOn(store.settingsAudit, 'append')
      .mockRejectedValueOnce(new Error('interrupted'))
    await expect(enrollSetupMachine(store, 'installation-a', request, actor)).rejects.toThrow(
      'interrupted',
    )
    expect(await store.machines.getMachine(asMachineId(request.machineId))).toBeUndefined()
    expect(await readSetupEnrollment(store, 'installation-a', request)).toBeUndefined()
    failure.mockRestore()
    expect((await enrollSetupMachine(store, 'installation-a', request, actor)).publicKey).toBe(
      request.publicKey,
    )
  })

  it('rejects a reused request with different values and a different installation collision', async () => {
    const { store, request } = await fixture()
    await enrollSetupMachine(store, 'installation-a', request, actor)
    await expect(
      enrollSetupMachine(store, 'installation-a', { ...request, agentExecution: false }, actor),
    ).rejects.toThrow('different values')
    await expect(enrollSetupMachine(store, 'installation-b', request, actor)).rejects.toThrow(
      'already enrolled',
    )
  })

  it('does not provision an uncommitted web setup request at boot', async () => {
    const { store, request } = await fixture()
    const { credentials } = await openTestIdentity(store)
    expect(
      await completePreauthorizedSetup(store, credentials, 'installation-a', request),
    ).toBeUndefined()
    expect(await store.machines.getMachine(asMachineId(request.machineId))).toBeUndefined()
  })

  it('binds the sole setup member and activates its password in the enrollment transaction', async () => {
    const { store, request } = await fixture(true, false)
    const { credentials } = await openTestIdentity(store)
    const member = (await store.users.soleActiveMember())!
    const staged = await hashPassword('setup password')
    const receipt = await completePreauthorizedSetup(
      store,
      credentials,
      'installation-a',
      request,
      staged,
    )
    expect(receipt?.actor).toBe(member.id)
    // The password is the password of the admin's account: it is what a sign-in checks.
    expect(await credentials.verifyPassword(asUserId(member.id), 'setup password')).toBe(true)
  })

  it('keeps a password the admin already has over the one setup staged', async () => {
    const { store, request } = await fixture(true, false)
    const { credentials } = await openTestIdentity(store)
    const member = asUserId((await store.users.soleActiveMember())!.id)
    await credentials.setPassword(member, 'their own password')
    await completePreauthorizedSetup(
      store,
      credentials,
      'installation-a',
      request,
      await hashPassword('staged later'),
    )
    expect(await credentials.verifyPassword(member, 'their own password')).toBe(true)
    expect(await credentials.verifyPassword(member, 'staged later')).toBe(false)
  })

  it('moves server assignment only in the explicit transfer transition and preserves agent execution', async () => {
    const { store, request } = await fixture()
    await enrollSetupMachine(store, 'installation-a', request, actor)
    const target = asMachineId('transfer-target')
    await store.machines.enrollMachine({
      id: target,
      name: 'target',
      hostname: 'target',
      tokenHash: 'legacy-hash',
      ownerUserId: actor,
      podiumManaged: true,
      assignment: { server: false, agentExecution: true },
      assignmentEvidence: { version: 1, source: 'setup', requestId: 'target-setup' },
    })
    await store.machines.transferServerAssignment(request.machineId, target, 'transfer-1')
    await store.machines.transferServerAssignment(request.machineId, target, 'transfer-1')
    expect(
      (await store.machines.getMachine(asMachineId(request.machineId)))?.serviceAssignment,
    ).toEqual({ server: false, agentExecution: true })
    expect((await store.machines.getMachine(target))?.serviceAssignment).toEqual({
      server: true,
      agentExecution: true,
    })
    expect(await store.machines.custodian(target)).toBe(actor)
  })

  it('records ambiguous first-boot membership as unowned and never re-infers it', async () => {
    const { store, request } = await fixture(true)
    await memberFacts(store).create(
      {
        id: asUserId('another-admin'),
        displayName: 'Other',
        role: 'admin',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'hash',
    )
    const { credentials } = await openTestIdentity(store)
    const first = await completePreauthorizedSetup(store, credentials, 'installation-a', request)
    expect(first?.actor).toBeNull()
    expect(await completePreauthorizedSetup(store, credentials, 'installation-a', request)).toEqual(
      first,
    )
  })
})

/**
 * A host upgraded from a release before setup enrollment (POD-5931): its own row is
 * `bearer-hash`, reached by the same-host secret that is no longer a credential.
 */
describe('legacy host adoption', () => {
  async function legacyHost(opts: { revoked?: boolean } = {}) {
    const { store, dir } = await fixture(false)
    const request = prepareSetupEnrollment(true, false, dir)
    const id = asMachineId(request.machineId)
    await store.machines.enrollMachine({
      id,
      name: 'upg-aio',
      hostname: 'upg-aio',
      tokenHash: 'a'.repeat(64),
      ownerUserId: actor,
      podiumManaged: true,
      assignment: { server: false, agentExecution: true },
      assignmentEvidence: { version: 1, source: 'legacy', requestId: 'legacy' },
    })
    if (opts.revoked) await store.machines.revokeMachine(id)
    return { store, dir, request, id }
  }

  it('re-keys the existing row in place, keeping its id and owner', async () => {
    const { store, dir, request, id } = await legacyHost()
    const receipt = await adoptLegacyHostMachine(store, 'installation-a', request)
    expect(receipt).toMatchObject({ machineId: id, publicKey: request.publicKey, actor })
    const row = await store.machines.getMachine(id)
    expect(row?.serviceAssignment).toEqual({ server: true, agentExecution: true })
    expect(await store.machines.custodian(id)).toBe(actor)
    expect(await store.machines.credentialIncarnation(id)).toBe(request.publicKey)
    // The host can now authenticate with the key its own state dir holds.
    confirmSetupEnrollment(request.requestId, request.publicKey, dir)
    const challenge = {
      type: 'machineChallenge' as const,
      machineId: id,
      installationId: 'installation-a',
      connectionId: 'c',
      nonce: 'n',
      expiresAtMs: Date.now() + 60_000,
    }
    const { machineHelloTranscript } = await import('@podium/protocol')
    expect(
      await store.machines.verifyMachineSignature(
        id,
        machineHelloTranscript(challenge),
        signMachineHello(challenge, dir),
      ),
    ).toBe(true)
  })

  it('answers a retry after a lost confirmation with the same receipt', async () => {
    const { store, request } = await legacyHost()
    const first = await adoptLegacyHostMachine(store, 'installation-a', request)
    expect(await adoptLegacyHostMachine(store, 'installation-a', request)).toEqual(first)
  })

  it('never re-keys a row that already has a key, is revoked, or does not exist', async () => {
    const keyed = await fixture()
    await enrollSetupMachine(keyed.store, 'installation-a', keyed.request, actor)
    const other = prepareSetupEnrollment(true, false, mkdtempSync(join(tmpdir(), 'podium-other-')))
    expect(
      await adoptLegacyHostMachine(keyed.store, 'installation-a', {
        ...other,
        machineId: keyed.request.machineId,
      }),
    ).toBeUndefined()
    expect(
      await keyed.store.machines.credentialIncarnation(asMachineId(keyed.request.machineId)),
    ).toBe(keyed.request.publicKey)

    const revoked = await legacyHost({ revoked: true })
    expect(
      await adoptLegacyHostMachine(revoked.store, 'installation-a', revoked.request),
    ).toBeUndefined()

    const missing = await fixture()
    expect(
      await adoptLegacyHostMachine(missing.store, 'installation-a', missing.request),
    ).toBeUndefined()
    expect(await missing.store.machines.getMachine(missing.request.machineId)).toBeUndefined()
  })
})

describe('offline server-assignment promotion on a transfer target', () => {
  // The target daemon runs this between installing the moved database and
  // starting its server: a store opened the way the server opens it, change
  // capture on from the end of the boot, and no registry to drain it
  // (POD-7100). The write cannot reach the log, so the kinds it captured go
  // up a generation and a client refetches them from the new server.
  // Server transfer moves a SQLite data file; hosted Postgres has no transfer.
  it.skipIf(testStoreEngine() === 'pg')(
    'moves the server bit on a store that captures changes, and retries',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-transfer-assignment-'))
      dirs.push(dir)
      vi.stubEnv('PODIUM_STATE_DIR', dir)
      vi.stubEnv('PODIUM_VAULT_KEY_FILE', join(dir, 'vault.key'))
      const source = asMachineId('transfer-source')
      const target = asMachineId('transfer-target')
      let before: SyncKindTokens | undefined
      try {
        const store = await SessionStore.open(join(dir, 'podium.db'), source)
        try {
          const owner = await firstAdminMemberId(store)
          // Setup: two enrolled machines, the source serving.
          await seedRows(store, async () => {
            await store.machines.upsertMachine({
              id: source,
              name: 'source',
              hostname: 'source',
              tokenHash: 'source-hash',
              ownerUserId: owner,
              assignment: { server: true, agentExecution: true },
            })
            await store.machines.upsertMachine({
              id: target,
              name: 'target',
              hostname: 'target',
              tokenHash: 'target-hash',
              ownerUserId: owner,
              assignment: { server: false, agentExecution: true },
            })
          })
          before = await readKindTokens(store.sync)
        } finally {
          await store.close()
        }

        const input = { sourceMachineId: source, targetMachineId: target, requestId: 'transfer-1' }
        await promoteMachineAssignment(input)
        await promoteMachineAssignment(input)

        const reopened = await SessionStore.open(join(dir, 'podium.db'), target)
        try {
          expect((await reopened.machines.getMachine(source))?.serviceAssignment).toEqual({
            server: false,
            agentExecution: true,
          })
          expect((await reopened.machines.getMachine(target))?.serviceAssignment).toEqual({
            server: true,
            agentExecution: true,
          })
          // The server bit is on the access record (the machine record reads its
          // name, version and channel), so a client holding the old access
          // records sees a new token for that kind alone and refetches it from
          // the new server; the retry changed nothing more.
          const after = await readKindTokens(reopened.sync)
          const changed = Object.keys(after)
            .filter((kind) => after[kind] !== before?.[kind])
            .sort()
          expect(changed).toEqual(['machineAccess'])
        } finally {
          await reopened.close()
        }
      } finally {
        vi.unstubAllEnvs()
      }
    },
  )
})
