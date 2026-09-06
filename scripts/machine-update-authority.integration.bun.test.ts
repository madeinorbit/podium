import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireSchemaDigest, type UpdateGrantMessage, type UpdateStatusMessage } from '@podium/protocol'
import { createMachineSupervisorConnection, loadSupervisorState } from '../packages/runtime/src/machine-supervisor'
import {
  MachineUpdateExecutor,
  type MachineUpdateAdapter,
  type MachineUpdateAuthority,
} from '../packages/runtime/src/machine-update'
import {
  requestMachineUpdate,
  startMachineUpdateControl,
} from '../packages/runtime/src/machine-update-control'

const dirs: string[] = []
const local: MachineUpdateAuthority = { kind: 'local' }
const coordinator = (serverUrl = 'wss://coordinator.example'): MachineUpdateAuthority => ({
  kind: 'coordinator', serverUrl, isCurrent: () => true,
})
const grant = (grantId: string, issuedAt: number): UpdateGrantMessage => ({
  type: 'updateGrant', grantId, issuedAt,
  target: { version: '2.0.0', critical: false, artifacts: {} },
})
function setup(runtimeDir?: string, overrides: Partial<MachineUpdateAdapter> = {}) {
  if (!runtimeDir) {
    runtimeDir = mkdtempSync(join(tmpdir(), 'podium-authority-'))
    dirs.push(runtimeDir)
  }
  let prepares = 0
  const statuses: UpdateStatusMessage[] = []
  const executor = new MachineUpdateExecutor({
    runtimeDir,
    adapter: {
      runningVersion: () => '2.0.0',
      runningDigest: () => 'exact',
      prepare: async () => { prepares++; return { digest: 'exact' } },
      activate: async () => {},
      discard: async () => {},
      restart: async () => {},
      ...overrides,
    },
    report: (status) => statuses.push(status),
  })
  return { executor, runtimeDir, statuses, prepares: () => prepares }
}
const accept = (executor: MachineUpdateExecutor, id: string, stamp: number, source?: MachineUpdateAuthority) =>
  executor.accept(grant(id, stamp), true, false, source)
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('authenticated update authority clocks', () => {
  for (const [localTime, fleetTime] of [[100, 1_000_000], [1_000_000, 100]]) {
    for (const localFirst of [true, false]) {
      it(`alternates clocks and restarts (local=${localTime}, fleet=${fleetTime}, localFirst=${localFirst})`, async () => {
        const first = setup()
        const sources = localFirst ? [local, coordinator()] : [coordinator(), local]
        const times = localFirst ? [localTime!, fleetTime!] : [fleetTime!, localTime!]
        await accept(first.executor, 'first', times[0]!, sources[0])
        await accept(first.executor, 'second', times[1]!, sources[1])
        const restarted = setup(first.runtimeDir)
        await accept(restarted.executor, 'third', times[0]! + 1, sources[0])
        await accept(restarted.executor, 'fourth', times[1]! + 1, sources[1])
        expect(restarted.executor.snapshot()?.phase).toBe('current')
        expect(restarted.prepares()).toBe(2)
        expect(restarted.executor.snapshot()?.authority).toBe(1_000_001)
        for (let i = 0; i < 2; i++) {
          await expect(accept(restarted.executor, `stale-${i}`, times[i]!, sources[i]))
            .rejects.toThrow('stale-authorization')
          await expect(accept(restarted.executor, `equal-${i}`, times[i]! + 1, sources[i]))
            .rejects.toThrow('stale-authorization')
        }
        expect(restarted.prepares()).toBe(2)
      })
    }
  }

  it('keeps full target and repair conflicts global across sources and restart', async () => {
    const first = setup()
    const exact = grant('retained', 100)
    await first.executor.accept(exact, true, false, local)
    await accept(first.executor, 'next', 1, coordinator())
    const restarted = setup(first.runtimeDir)
    for (const changed of [
      { ...exact, target: { ...exact.target, version: 'other' } },
      { ...exact, target: { ...exact.target, critical: true } },
      { ...exact, target: { ...exact.target, trust: 'release' as const } },
      { ...exact, target: { ...exact.target, schema: { migrations: ['new'] } } },
      { ...exact, repair: true },
      { ...exact, target: { ...exact.target, artifacts: {
        headless: { delivery: 'feed' as const, platforms: {
          test: { url: 'https://example.com/changed', signature: 'changed', digest: 'changed' },
        } },
      } } },
    ]) {
      await expect(restarted.executor.accept(changed, true, false, coordinator()))
        .rejects.toThrow('grant-id-conflict')
    }
    await restarted.executor.accept(exact, true, false, coordinator())
    expect(restarted.prepares()).toBe(0)
    expect(restarted.statuses.at(-1)?.grantId).toBe('retained')
    expect(restarted.executor.snapshot()?.grant.grantId).toBe('next')
    await expect(restarted.executor.accept({ ...grant('next', 999), repair: true }, true, false, local))
      .rejects.toThrow('grant-id-conflict')
  })

  it('never infers new sources from raw namespace claims or ID prefixes', async () => {
    const { executor, prepares } = setup()
    await accept(executor, 'normal', 100, local)
    await expect(executor.accept({
      ...grant('native-fresh-looking', 99),
      authority: 'new-issuer', issuer: 'coordinator',
    } as UpdateGrantMessage, true, false, local)).rejects.toThrow('stale-authorization')
    await expect(executor.accept({ ...grant('cli-new', 99), issuer: 'new' } as UpdateGrantMessage))
      .rejects.toThrow('stale-authorization')
    expect(prepares()).toBe(1)
  })

  it('retains coordinator replacement and return fences without comparing their clocks', async () => {
    const first = setup()
    await accept(first.executor, 'old-coordinator', 1_000_000, coordinator())
    await accept(first.executor, 'new-coordinator', 1, coordinator('wss://replacement.example'))
    const restarted = setup(first.runtimeDir)
    await expect(accept(restarted.executor, 'old-delayed', 999_999, coordinator()))
      .rejects.toThrow('stale-authorization')
    await accept(restarted.executor, 'old-new', 1_000_001, coordinator())
    // Equivalent URL spellings, credentials/reconnection, and key rotation do
    // not create a new endpoint domain with an empty watermark.
    await expect(accept(restarted.executor, 'alias', 1, coordinator('wss://COORDINATOR.example:443/')))
      .rejects.toThrow('stale-authorization')
  })

  it('refuses an obsolete connection even for an exact duplicate', async () => {
    const { executor } = setup()
    await accept(executor, 'accepted', 100, coordinator())
    const obsolete: MachineUpdateAuthority = {
      kind: 'coordinator', serverUrl: 'wss://coordinator.example', isCurrent: () => false,
    }
    await expect(accept(executor, 'accepted', 100, obsolete)).rejects.toThrow('no longer current')
    await expect(accept(executor, 'new', 101, obsolete)).rejects.toThrow('no longer current')
  })

  it('checks transfer again after cancellation yields, before installing new authority', async () => {
    let current = true
    const { executor, prepares } = setup(undefined, { discard: async () => { current = false } })
    await executor.accept(grant('held', 100), true, true, local)
    await expect(accept(executor, 'superseding', 1, {
      kind: 'coordinator', serverUrl: 'wss://coordinator.example', isCurrent: () => current,
    })).rejects.toThrow('no longer current')
    expect(executor.snapshot()?.grant.grantId).toBe('held')
    expect(executor.snapshot()?.phase).toBe('canceled')
    expect(prepares()).toBe(1)
  })

  it('keeps pre-activation cancellation and committed exact-health fencing across sources', async () => {
    const { executor } = setup(undefined, { restart: async () => 'handover-pending' })
    await executor.accept(grant('held', 1000), true, true, local)
    await accept(executor, 'fleet', 1, coordinator())
    expect(executor.snapshot()?.completed.held?.phase).toBe('canceled')
    expect(executor.snapshot()?.phase).toBe('restarting')
    await expect(accept(executor, 'local-next', 1001, local)).rejects.toThrow('update-committed')
    expect(await executor.cancel('fleet')).toBe(false)
    await executor.confirmBoot(false)
    expect(executor.snapshot()?.phase).toBe('restarting')
    await executor.confirmBoot(true)
    expect(executor.snapshot()?.phase).toBe('current')
    await accept(executor, 'local-next', 1001, local)
  })

  it('retains retired watermarks through endpoint churn without an update lockout', async () => {
    const { executor, prepares } = setup()
    await accept(executor, 'local', 1, local)
    for (let i = 0; i < 40; i++)
      await accept(executor, `grant-${i}`, 1, coordinator(`wss://coordinator-${i}.example`))
    await expect(accept(executor, 'retired', 1, coordinator('wss://coordinator-0.example')))
      .rejects.toThrow('stale-authorization')
    await accept(executor, 'local-next', 2, local)
    expect(prepares()).toBe(42)
  })
})

describe('journal and grant compatibility', () => {
  it('preserves an unattributed format-1 fence without guessing from native or cli IDs', async () => {
    const original = setup()
    await accept(original.executor, 'native-old', 100, local)
    const journal = original.executor.snapshot()!
    delete journal.authorityHistory
    writeFileSync(join(original.runtimeDir, 'machine-update.json'), JSON.stringify(journal))
    const restarted = setup(original.runtimeDir)
    for (const source of [local, coordinator(), undefined])
      await expect(accept(restarted.executor, 'legacy-stale', 99, source))
        .rejects.toThrow('stale-authorization')
    await restarted.executor.accept(journal.grant, true, false, local)
    expect(restarted.prepares()).toBe(0)
    await accept(restarted.executor, 'local-new', 101, local)
    await accept(restarted.executor, 'fleet-new', 102, coordinator())
    // Once a source has crossed the legacy floor, only its own stamp applies.
    await accept(restarted.executor, 'local-next', 102, local)
    expect(restarted.executor.snapshot()?.authorityHistory?.legacyFloor).toBe(100)
  })

  it('old wire grants need no namespace, but still need a stamp for new work', async () => {
    const { executor } = setup()
    await accept(executor, 'old-wire', 100, local)
    await accept(executor, 'old-fleet-wire', 1, coordinator())
    await expect(executor.accept({ ...grant('undated', 100), issuedAt: undefined }, true, false, local))
      .rejects.toThrow('requires dated exact authorization')
    await executor.accept({ ...grant('old-wire', 100), issuedAt: undefined }, true, false, local)
  })

  it('keeps a conservative scalar fence for old binary rollback and journal rewrite', async () => {
    const original = setup()
    await accept(original.executor, 'fleet', 1000, coordinator())
    await accept(original.executor, 'local', 1, local)
    const legacy = original.executor.snapshot()!
    expect(legacy.authority).toBe(1000)
    delete legacy.authorityHistory // An old reader strips fields it does not know.
    writeFileSync(join(original.runtimeDir, 'machine-update.json'), JSON.stringify(legacy))
    const restored = setup(original.runtimeDir)
    await expect(accept(restored.executor, 'stale', 999, coordinator())).rejects.toThrow('stale-authorization')
  })

  it('refuses malformed durable authority instead of starting empty history', async () => {
    const original = setup()
    await accept(original.executor, 'local', 1, local)
    const journal = original.executor.snapshot()!
    writeFileSync(join(original.runtimeDir, 'machine-update.json'), JSON.stringify({
      ...journal, authorityHistory: { watermarks: { local: 'invalid' } },
    }))
    expect(() => setup(original.runtimeDir)).toThrow()
  })
})

it('authenticates the local socket before binding authority, and ignores wire issuer claims', async () => {
  const { executor, runtimeDir } = setup()
  await accept(executor, 'fleet', 1_000_000, coordinator())
  const control = await startMachineUpdateControl(runtimeDir, executor)
  try {
    const endpoint = JSON.parse(readFileSync(join(runtimeDir, 'machine-update-control.json'), 'utf8'))
    const unauthorized = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ socketPath: endpoint.socketPath, path: '/grant', method: 'POST' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end(JSON.stringify(grant('unauthorized', 1)))
    })
    expect(unauthorized).toBe(401)
    expect(executor.snapshot()?.grant.grantId).toBe('fleet')
    await requestMachineUpdate(runtimeDir, '/prepare', { ...grant('local', 1), issuer: 'fleet' })
    await executor.confirmBoot(true)
    expect(executor.snapshot()?.phase).toBe('prepared')
    expect(executor.snapshot()?.authorityHistory?.watermarks.local).toBe(1)
    await expect(requestMachineUpdate(runtimeDir, '/grant', {
      ...grant('stale-local', 0), authority: 'fresh-namespace',
    })).rejects.toThrow('stale-authorization')
    await requestMachineUpdate(runtimeDir, '/activate', { grantId: 'local' })
    await executor.confirmBoot(true)
    expect(executor.snapshot()?.phase).toBe('current')
    await accept(executor, 'fleet-next', 1_000_001, coordinator())
  } finally {
    await control.close()
  }
})


it('binds grants to the established configured coordinator and revokes queued contexts on transfer', () => {
  const OriginalWebSocket = globalThis.WebSocket
  class Socket extends EventTarget {
    static OPEN = 1
    static all: Socket[] = []
    readyState = 1
    sent: Array<Record<string, unknown>> = []
    constructor(readonly url: string | URL) { super(); Socket.all.push(this) }
    send(raw: string) { this.sent.push(JSON.parse(raw)) }
    close() {}
    message(value: unknown) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
    }
    establish() {
      this.dispatchEvent(new Event('open'))
      this.message({ type: 'peerHelloOk', v: this.sent[0]!.v, caps: [] })
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  const { runtimeDir } = setup()
  let endpoint = 'wss://old.example'
  const received: MachineUpdateAuthority[] = []
  const service = { policy: 'enabled' as const, state: 'available' as const, observedAt: new Date().toISOString() }
  const connection = createMachineSupervisorConnection({
    serverUrl: () => endpoint,
    bootstrapToken: 'private-test-secret',
    stateDir: runtimeDir,
    state: loadSupervisorState(runtimeDir),
    build: { appVersion: 'test', wireSchemaDigest: wireSchemaDigest() },
    deliveryCaps: ['update.delivery.feed'],
    report: () => ({ server: service, agentExecution: service }),
    onGrant: (_grant, authority) => received.push(authority),
  })
  try {
    connection.start()
    const old = Socket.all[0]!
    old.establish()
    old.message({ ...grant('coordinator', 1), authority: 'untrusted-namespace' })
    expect(received).toHaveLength(1)
    const context = received[0]!
    expect(context.kind).toBe('coordinator')
    if (context.kind !== 'coordinator') throw new Error('missing coordinator provenance')
    expect(context.serverUrl).toBe(endpoint)
    expect(context.isCurrent()).toBe(true)
    // Config can commit before the topology callback reconfigures the socket.
    endpoint = 'wss://replacement.example'
    expect(context.isCurrent()).toBe(false)
    old.message(grant('old-after-config', 2))
    expect(received).toHaveLength(1)
    connection.reconfigure()
    const replacement = Socket.all[1]!
    replacement.establish()
    replacement.message(grant('replacement', 1))
    old.message(grant('late-old-socket', 3))
    expect(received).toHaveLength(2)
    const replaced = received[1]!
    if (replaced.kind !== 'coordinator') throw new Error('missing replacement provenance')
    expect(replaced.serverUrl).toBe(endpoint)
    expect(replaced.isCurrent()).toBe(true)
    connection.reconfigure() // Same endpoint, new connection: old callbacks revoked.
    expect(replaced.isCurrent()).toBe(false)
  } finally {
    connection.close()
    globalThis.WebSocket = OriginalWebSocket
  }
})

it('canceled boot confirmation queued behind recovery makes no delayed writes or reports', async () => {
  const original = setup(undefined, { restart: async () => 'handover-pending' })
  await accept(original.executor, 'committed', 1, local)
  const journal = original.executor.snapshot()!
  journal.phase = 'activating'
  writeFileSync(join(original.runtimeDir, 'machine-update.json'), JSON.stringify(journal))
  let releaseRecovery!: () => void
  let startedRecovery!: () => void
  const held = new Promise<void>((resolve) => { releaseRecovery = resolve })
  const started = new Promise<void>((resolve) => { startedRecovery = resolve })
  const recovered = setup(original.runtimeDir, {
    recoverActivation: async () => { startedRecovery(); await held },
  })
  const recovery = recovered.executor.recoverBeforeBoot()
  await started
  const before = readFileSync(join(original.runtimeDir, 'machine-update.json'), 'utf8')
  const observer = new AbortController()
  const confirmation = recovered.executor.confirmBoot(true, observer.signal)
  observer.abort()
  releaseRecovery()
  await Promise.all([recovery, confirmation])
  expect(recovered.statuses).toHaveLength(0)
  expect(recovered.prepares()).toBe(0)
  expect(readFileSync(join(original.runtimeDir, 'machine-update.json'), 'utf8')).toBe(before)
  await recovered.executor.confirmBoot(true)
  expect(recovered.executor.snapshot()?.phase).toBe('current')
})
