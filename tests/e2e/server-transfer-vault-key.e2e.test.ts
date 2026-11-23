/**
 * THE VAULT KEY MOVES WITH THE SERVER (credential management design §7, "Moving
 * the server"; epic Task 22, acceptance 1 and 3).
 *
 * Two state directories with real files, two vault key files, one process: the
 * source is a real store with a credential sealed in its vault, driven by the
 * real transfer service, wire builders and adapter; the target is the real daemon
 * transfer handlers on their own state directory and key file, with the
 * production promotion of the server assignment. Only the socket between them is
 * replaced, by a broker that parses every control message the way the wire does
 * and hands it to the daemon.
 *
 * After the move the credential opens on the target, the target's `vault_key`
 * row names its own key file, that file is 0600, and the source's key file is
 * gone. The source journal, the target's stage and state files and every log
 * record are searched for the data key in raw, hex and base64 form; the same
 * search first finds a canary planted in each of those places.
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink, createLogger, type LogRecord } from '@podium/logger'
import { asMachineId, firstAdminMemberId, primeFirstAdminMember, type UserId } from '@podium/model'
import { wireSchemaDigest } from '@podium/protocol'
import { ControlMessage, type DaemonMessage } from '@podium/protocol/daemon'
import { saveConfig } from '@podium/runtime/config'
import { openDatabase } from '@podium/runtime/sqlite'
import { fileKeyProvider, readWrappedDataKey } from '@podium/runtime/vault-key'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DaemonContext } from '../../apps/daemon/src/control/context'
import { sealCredentialSecret, withSecret } from '../../apps/server/src/modules/credentials/vault'
import type { DaemonRequestPort } from '../../apps/server/src/modules/daemon-request'
import { DaemonRpcService } from '../../apps/server/src/modules/machines/rpc'
import { serverTransferRpcAdapter } from '../../apps/server/src/modules/server-transfer/rpc-adapter'
import { ServerTransferService } from '../../apps/server/src/modules/server-transfer/service'
import { SERVER_TRANSFER_CONFIRMATION } from '../../apps/server/src/modules/server-transfer/types'
import { SessionStore } from '../../apps/server/src/store'
import { seedRows } from '../../apps/server/src/test-support/seed-rows'
import { promoteMachineAssignment } from '../../apps/server/src/transfer-machine-assignment'

const SOURCE = asMachineId('source-machine')
const TARGET = asMachineId('target-machine')
// Obviously fake.
const SECRET = 'FAKE-sk-server-transfer-0001'

let base = ''
const bases: string[] = []
let sourceRoot = ''
let targetRoot = ''
let sourceKeyPath = ''
let targetKeyPath = ''
const previousEnv = {
  state: process.env.PODIUM_STATE_DIR,
  keyFile: process.env.PODIUM_VAULT_KEY_FILE,
}
const records: LogRecord[] = []
let removeSink: () => void = () => {}

/** `key` raw, in hex (both cases) and in base64 (standard and url-safe). */
function encodings(key: Buffer): Buffer[] {
  return [
    key,
    Buffer.from(key.toString('hex')),
    Buffer.from(key.toString('hex').toUpperCase()),
    Buffer.from(key.toString('base64')),
    Buffer.from(key.toString('base64url')),
  ]
}

/** Every file under `dir` whose bytes hold `key` in any encoding. */
function filesHolding(dir: string, key: Buffer): string[] {
  const needles = encodings(key)
  const found: string[] = []
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (needles.some((needle) => readFileSync(path).includes(needle))) found.push(path)
  }
  return found
}

function logsHolding(key: Buffer): number {
  const needles = encodings(key).map((needle) => needle.toString('latin1'))
  return records.filter((record) => {
    const text = JSON.stringify(record)
    return needles.some((needle) => text.includes(needle))
  }).length
}

/** Hands each control message, parsed as the wire parses it, to the target daemon. */
function inProcessBroker(
  handlers: typeof import('../../apps/daemon/src/server-transfer').serverTransferHandlers,
): DaemonRequestPort {
  let counter = 0
  const nextRequestId = (prefix: string) => `${prefix}-${++counter}`
  return {
    nextRequestId,
    settle: () => false,
    async request(spec) {
      const message = ControlMessage.parse(await spec.build(nextRequestId('transfer')))
      return await new Promise((resolve) => {
        const ctx = {
          machineId: TARGET,
          // The production promotion, on the installed database: it moves the
          // server bit on a store that captures changes with no server running.
          promoteMachineAssignment,
          restartAfterTransfer: async (expected: unknown) => expected,
          retireAfterTransfer: () => {},
          send: (reply: DaemonMessage) => {
            if (reply.type !== 'serverTransferResult') return
            if (reply.requestId !== message.requestId) return
            const { type: _type, requestId: _requestId, ...payload } = reply
            resolve(payload as never)
          },
        } as unknown as DaemonContext
        const handler = handlers[message.type as keyof typeof handlers]
        if (!handler) throw new Error(`no target handler for ${message.type}`)
        handler(ctx, message as never)
      })
    },
  }
}

/** Fresh source and target state directories and key files for one move. */
function useFreshMachines(): void {
  base = mkdtempSync(join(tmpdir(), 'podium-transfer-vault-'))
  sourceRoot = join(base, 'source-state')
  targetRoot = join(base, 'target-state')
  sourceKeyPath = join(base, 'source-config', 'podium', 'vault-source.key')
  targetKeyPath = join(base, 'target-config', 'podium', 'vault-target.key')
  bases.push(base)
  // The daemon reads its state directory and key file the way it does in production.
  process.env.PODIUM_STATE_DIR = targetRoot
  process.env.PODIUM_VAULT_KEY_FILE = targetKeyPath
  // The target is a paired daemon: only one can become the server.
  saveConfig({ mode: 'daemon', serverUrl: 'wss://source.example.com' })
}

/** The source store, serving, with the target enrolled in it. */
async function openSource(): Promise<{ source: SessionStore; owner: UserId }> {
  const source = await SessionStore.open(
    join(sourceRoot, 'podium.db'),
    { id: SOURCE },
    {
      vaultKeyFile: sourceKeyPath,
    },
  )
  primeFirstAdminMember(await firstAdminMemberId(source))
  const owner = await firstAdminMemberId(source)
  // The enrolments are setup, not the write under test. The store opens as a
  // server does, capturing changes from the end of the boot, but no registry
  // drains them into a machine-record commit here, so the machine rows are
  // seeded below the commit layer. The capture stays on for the move itself.
  await seedRows(source, async () => {
    await source.machines.upsertMachine({
      id: SOURCE,
      name: 'source',
      hostname: 'source',
      tokenHash: 'source-token-hash',
      ownerUserId: owner,
      assignment: { server: true, agentExecution: true },
    })
    await source.machines.upsertMachine({
      id: TARGET,
      name: 'target',
      hostname: 'target',
      tokenHash: 'target-token-hash',
      ownerUserId: owner,
      assignment: { server: false, agentExecution: true },
    })
  })
  return { source, owner }
}

/** Move the server from `source` to the target daemon through the real service. */
async function moveServer(source: SessionStore) {
  const { serverTransferHandlers } = await import('../../apps/daemon/src/server-transfer')
  // A bare store is provisioned with this workspace's own feed identity.
  // Use its scoped repository, just as the running server does.
  const readFeed = async () => {
    const identity = await source.sync.readFeedIdentity()
    if (!identity) throw new Error('the source workspace has no feed identity')
    return { feedId: identity.feedId, feedEpoch: identity.epoch }
  }
  const target = () => ({
    exists: true,
    online: true,
    capable: true,
    hasDaemon: true,
    vaultKeyHandover: true,
  })
  const wire = new DaemonRpcService({
    broker: inProcessBroker(serverTransferHandlers),
    serverPlacement: { kind: 'fleet', machineId: SOURCE },
  } as unknown as ConstructorParameters<typeof DaemonRpcService>[0])
  const service = new ServerTransferService({
    stateRoot: sourceRoot,
    sourceInstanceId: 'source-instance',
    hostMachine: { id: SOURCE },
    sourceFeedIdentity: readFeed,
    sourceApplicationVersion: 'test',
    sourceSchemaVersion: () => source.schemaVersionForTransfer(),
    sourceWireSchemaDigest: wireSchemaDigest(),
    rpc: serverTransferRpcAdapter(wire),
    targetState: target,
    targetStateResolver: () => target,
    targetLinkKind: () => 'encrypted',
    vault: source.vault,
    localPromotedTransfer: () => undefined,
    sourceHealthy: () => source.checkpointForTransfer(),
    checkpoint: () => source.checkpointForTransfer(),
    fence: () => {},
    releaseFence: () => {},
    demoteSource: () => {},
    acknowledgementTimeoutMs: 5_000,
  })
  return await service.transfer(
    {
      targetMachineId: TARGET,
      publicUrl: 'https://podium.example.com',
      bindHost: '0.0.0.0',
      confirmation: SERVER_TRANSFER_CONFIRMATION,
    },
    { reauthorize: () => {} },
  )
}

describe('server transfer moves the vault key', () => {
  beforeAll(() => {
    removeSink = addSink({ name: 'transfer-vault-test', write: (record) => records.push(record) })
  })

  afterAll(() => {
    removeSink()
    if (previousEnv.state === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previousEnv.state
    if (previousEnv.keyFile === undefined) delete process.env.PODIUM_VAULT_KEY_FILE
    else process.env.PODIUM_VAULT_KEY_FILE = previousEnv.keyFile
    for (const dir of bases) rmSync(dir, { recursive: true, force: true })
  })

  it('opens the source credential on the target and leaves no copy of the data key', async () => {
    useFreshMachines()
    // The source: a real store, a credential sealed in its vault.
    const { source, owner } = await openSource()
    const credential = await source.credentials.insert({
      ownerUserId: owner,
      label: 'Moved key',
      type: 'anthropic.api-key',
    })
    expect(await sealCredentialSecret(source, credential, SECRET, 0)).toBe(1)
    const dataKey = source.vault.exportDataKey()
    if (!dataKey) throw new Error('the source vault has no data key')
    expect(statSync(sourceKeyPath).isFile()).toBe(true)

    const outcome = await moveServer(source)
    expect(outcome, JSON.stringify(outcome.error)).toMatchObject({ ok: true, state: 'committed' })
    await source.close()

    // Acceptance 1: the credential opens on the target, under the target's own key file.
    expect(existsSync(sourceKeyPath)).toBe(false)
    expect(statSync(targetKeyPath).mode & 0o777).toBe(0o600)
    const targetProvider = await fileKeyProvider(targetKeyPath)
    const installed = openDatabase(join(targetRoot, 'podium.db'), { readOnly: true })
    try {
      const row = readWrappedDataKey(installed)
      expect(row?.keyId).toBe(targetProvider.keyId)
      expect(
        (installed.prepare('SELECT count(*) AS n FROM vault_key').get() as { n: number }).n,
      ).toBe(1)
    } finally {
      installed.close()
    }
    const target = await SessionStore.open(
      join(targetRoot, 'podium.db'),
      { id: TARGET },
      {
        vaultKeyFile: targetKeyPath,
      },
    )
    try {
      expect(target.vault.state()).toBe('ready')
      expect(await withSecret(target, credential.id, async (secret) => secret)).toBe(SECRET)
      // The promotion moved the server bit to the target.
      expect((await target.machines.getMachine(SOURCE))?.serviceAssignment?.server).toBe(false)
      expect((await target.machines.getMachine(TARGET))?.serviceAssignment?.server).toBe(true)
    } finally {
      await target.close()
    }

    // Acceptance 3: the search finds a canary in each place it looks...
    const canary = Buffer.alloc(32, 0x3c)
    const places = {
      sourceJournal: join(sourceRoot, '.server-transfer'),
      targetStage: join(targetRoot, '.server-transfer'),
      targetState: targetRoot,
    }
    for (const [name, dir] of Object.entries(places)) {
      const planted = join(dir, `canary-${name}-${randomUUID()}.txt`)
      writeFileSync(planted, `canary ${canary.toString('base64')}\n`)
      expect(filesHolding(dir, canary)).toContain(planted)
      rmSync(planted)
    }
    createLogger('test:canary').warn('canary', { value: canary.toString('hex') })
    expect(logsHolding(canary)).toBe(1)
    expect(records.length).toBeGreaterThan(1)

    // ...and the data key in none of them.
    for (const dir of Object.values(places)) expect(filesHolding(dir, dataKey)).toEqual([])
    expect(logsHolding(dataKey)).toBe(0)
    dataKey.fill(0)
  }, 120_000)

  it('moves an empty vault; the target makes its own data key at its first seal', async () => {
    useFreshMachines()
    const { source, owner } = await openSource()
    expect(source.vault.state()).toBe('empty')

    const outcome = await moveServer(source)
    expect(outcome, JSON.stringify(outcome.error)).toMatchObject({ ok: true, state: 'committed' })
    await source.close()
    expect(existsSync(targetKeyPath)).toBe(false)

    const target = await SessionStore.open(
      join(targetRoot, 'podium.db'),
      { id: TARGET },
      {
        vaultKeyFile: targetKeyPath,
      },
    )
    try {
      expect(target.vault.state()).toBe('empty')
      const credential = await target.credentials.insert({
        ownerUserId: owner,
        label: 'Added after the move',
        type: 'openai.api-key',
      })
      expect(await sealCredentialSecret(target, credential, `${SECRET}-new`, 0)).toBe(1)
      expect(target.vault.state()).toBe('ready')
      expect(statSync(targetKeyPath).mode & 0o777).toBe(0o600)
      expect(target.vault.status().keyId).toBe((await fileKeyProvider(targetKeyPath)).keyId)
      expect(await withSecret(target, credential.id, async (secret) => secret)).toBe(
        `${SECRET}-new`,
      )
    } finally {
      await target.close()
    }
  }, 120_000)
})
