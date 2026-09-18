import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import { machineRotationTranscript, MAINTENANCE_PROTOCOL_VERSION, MAINTENANCE_SCHEMA_VERSION } from '@podium/protocol'
import { createMaintenanceHttpClient } from '@podium/janitor'
import { loadMachineState, updateMachineState } from '@podium/runtime/local-machine'
import { acknowledgeMachineCredentialRotation, machinePublicKeyWire, prepareMachineCredentialRotation, signWithMachine } from '@podium/runtime/machine-credential'
import { readHostMachineCredential } from '@podium/runtime/maintenance-credential'
import { identityShapes, writeIdentityShape } from '../../../../../packages/runtime/src/fixtures/customer-upgrade'
import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { registerMaintenanceRoute } from './route'

const request = { protocolVersion: MAINTENANCE_PROTOCOL_VERSION, schemaVersion: MAINTENANCE_SCHEMA_VERSION, generationId: 'upgrade' }

it.each(identityShapes)('$name: maintenance survives first boot, then rotation retires the legacy file', async (shape) => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-upgrade-'))
  const host = asMachineId(shape.authenticatedId)
  const store = await openTestStore(':memory:', host)
  try {
    writeIdentityShape(root, shape)
    writeFileSync(join(root, 'daemon.secret'), shape.token)
    loadMachineState(root)
    await store.machines.upsertMachine({ id: host, name: shape.name, hostname: shape.name,
      tokenHash: createHash('sha256').update(shape.token).digest('hex'), ownerUserId: null })
    const app = new Hono()
    registerMaintenanceRoute(app, {
      machineId: host, installationId: 'fixture-installation',
      authenticateToken: (token) => store.machines.getMachineByToken(host, token),
      authenticateSignature: (transcript, signature) => store.machines.verifyMachineSignature(host, transcript, signature),
      service: {
        handshake: () => ({ status: 'ready', fencingToken: 1, expiresAt: '2099-01-01T00:00:00Z',
          messageWaitTtlMs: 1, autoArchiveReadWindowMs: 1, eventRetentionMaxAgeDays: 1,
          eventRetentionMaxRows: 1, changeKeepRows: 1, changeMaxAgeMs: 1, maintenanceCommandMaxAgeMs: 1,
          worktreeGcMode: 'propose', worktreeGcAfterDays: 1 }),
        apply: (command) => ({ status: 'applied', jobKind: command.jobKind, runKey: command.runKey }),
      },
    })
    const fetchFn = ((url: string | URL | Request, init?: RequestInit) => app.request(url instanceof URL ? url.toString() : url, init)) as typeof fetch
    const client = createMaintenanceHttpClient('http://maintenance', { credentialDir: root }, fetchFn)
    expect((await client.handshake(request)).status).toBe('ready')
    expect(existsSync(join(root, 'machine.key'))).toBe(false)
    writeFileSync(join(root, 'daemon.secret'), 'unrelated-secret')
    expect((await client.handshake(request)).status).toBe('ready')
    // Legacy file alone must pass the SAME database bearer verifier.
    updateMachineState(root, (state) => { delete (state.supervisor ?? state.daemon)!.token })
    await expect(client.handshake(request)).rejects.toThrow(/401/)
    writeFileSync(join(root, 'daemon.secret'), shape.token)
    expect((await client.handshake(request)).status).toBe('ready')
    updateMachineState(root, (state) => { (state.supervisor ?? state.daemon)!.token = shape.token })
    const prepared = prepareMachineCredentialRotation(root)
    const next = prepared.pendingRotation!
    const publicKey = machinePublicKeyWire(next)
    const transcript = machineRotationTranscript({ machineId: host, installationId: 'fixture-installation', connectionId: 'rotation', nonce: 'rotation-nonce' }, publicKey, publicKey)
    expect(await store.machines.rotateCredential(host, { newKeyId: publicKey, newPublicKey: publicKey,
      newSignature: signWithMachine(next, transcript), previous: { kind: 'bearer-hash', token: shape.token } }, transcript)).toBe(true)
    expect(existsSync(join(root, 'daemon.secret'))).toBe(true) // until acknowledgement
    updateMachineState(root, (state) => { const section = (state.supervisor ?? state.daemon)!; section.enrolledPublicKey = publicKey; delete section.token })
    expect(acknowledgeMachineCredentialRotation(root, publicKey)).toBe(true)
    expect(existsSync(join(root, 'daemon.secret'))).toBe(false)
    const keyBytes = readFileSync(join(root, 'machine.key'), 'utf8')
    expect((await client.handshake(request)).status).toBe('ready') // same client follows rotation
    expect(readFileSync(join(root, 'machine.key'), 'utf8')).toBe(keyBytes)
    expect((await app.request('/maintenance/handshake', { method: 'POST', headers: { authorization: `Bearer ${shape.token}` }, body: JSON.stringify(request) })).status).toBe(401)
    writeFileSync(join(root, 'daemon.secret'), shape.token)
    expect(readHostMachineCredential(root).kind).toBe('key')
    expect(acknowledgeMachineCredentialRotation(root, publicKey)).toBe(true)
    expect(existsSync(join(root, 'daemon.secret'))).toBe(false)
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }) }
})
