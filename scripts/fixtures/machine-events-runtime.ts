/** Production machine gateway + registry composition, isolated by the parent test. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { asMachineId } from '@podium/model'
import {
  createHandshakeDialer,
  type MachineSupervisorReportMessage,
  type UpdateGrantMessage,
  type UpdateTarget,
} from '@podium/protocol'
import { SessionRegistry } from '../../apps/server/src/relay'
import { attachWebSockets, serveNative } from '../../apps/server/src/gateway/ws-server'
import type { UpdateOperationContext } from '../../apps/server/src/modules/updates/operation'

console.error('[machine-events] constructing registry')
const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'blue' })
console.error('[machine-events] registry ready')
const { machines, updates, operations } = registry.modules
const machineId = asMachineId(randomUUID())
const token = randomUUID()
registry.sessionStore.machines.upsertMachine({
  id: machineId,
  name: 'zero-role',
  hostname: 'zero-role',
  ownerUserId: null,
  tokenHash: createHash('sha256').update(token).digest('hex'),
})
registry.sessionStore.machines.setServiceAssignment(machineId, {
  server: false,
  agentExecution: false,
})
registry.sessionStore.machines.setUpdateChannel(machineId, 'dev')
machines.invalidateMachineCache()
const target: UpdateTarget = {
  version: '2.0.0',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: {
        'linux-x86_64': {
          url: 'https://example.test/exact.tar.gz',
          digest: 'a'.repeat(64),
          signature: 'approved-signature',
        },
      },
    },
  },
}
const context: UpdateOperationContext = {
  updates,
  channel: 'dev',
  appVersion: () => target.version,
  onlyMachines: [machineId],
  surface: 'policy',
}
const transport = attachWebSockets(registry)
const server = serveNative({
  port: 0,
  hostname: '127.0.0.1',
  websocket: transport.websocket,
  fetch: async (request, native) => {
    const upgrade = await transport.handleRequest(request, native)
    return upgrade === null ? new Response('not found', { status: 404 }) : upgrade
  },
})
const sockets: WebSocket[] = []
let connects = 0
let disconnects = 0
registry.bus.on('machine.connected', ({ machineId: id }) => {
  if (id === machineId) connects++
})
registry.bus.on('machine.disconnected', ({ machineId: id }) => {
  if (id === machineId) disconnects++
})
// `check` may be async now that the machine reads are promises. It MUST be
// awaited: `!somePromise` is always false, so a bare call would make every
// wait exit on its first turn and pass vacuously.
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 5000) {
  console.error(`[machine-events] waiting: ${label}`)
  const end = Date.now() + timeout
  while (!(await check())) {
    assert(Date.now() < end, `timed out: ${label}`)
    await Bun.sleep(10)
  }
}
async function connect() {
  const frames: Array<Record<string, unknown>> = []
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/machine`)
  sockets.push(socket)
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)))
  await until(() => socket.readyState === WebSocket.OPEN, 'socket open')
  const dialer = createHandshakeDialer({
    peerRole: 'machine',
    credential: { kind: 'machineToken', token, machineHint: machineId },
    claims: { machineId, hostname: 'zero-role' },
    caps: ['update.delivery.feed'],
    build: { appVersion: '1.0.0', installKind: 'installed' },
  })
  socket.send(JSON.stringify(dialer.hello()))
  await until(
    () => frames.some((frame) => frame.type === 'serviceAssignment'),
    'authenticated assignment',
  )
  assert.deepEqual(frames.find((frame) => frame.type === 'serviceAssignment')?.assignment, {
    server: false,
    agentExecution: false,
  })
  const observedAt = new Date().toISOString()
  const report: MachineSupervisorReportMessage = {
    type: 'machineReport',
    services: {
      crashOwner: 'desktop',
      server: { policy: 'disabled', state: 'stopped', observedAt },
      agentExecution: { policy: 'disabled', state: 'stopped', observedAt },
    },
  }
  socket.send(JSON.stringify(report))
  await until(
    async () =>
      (await machines.listMachines()).find((m) => m.id === machineId)?.services?.server.state ===
      'stopped',
    'zero-role report',
  )
  return {
    socket,
    frames,
    grants: () => frames.filter((f) => f.type === 'updateGrant') as unknown as UpdateGrantMessage[],
  }
}
async function start() {
  console.error('[machine-events] starting operation')
  const result = await operations.engine.start('update', context, { createdBy: 'user' })
  assert(result.started, JSON.stringify(result))
  console.error(`[machine-events] settling operation ${result.operation.id}`)
  await operations.engine.whenSettled(result.operation.id)
  console.error('[machine-events] operation settled')
  return result.operation.id
}
try {
  const first = await connect()
  assert.equal(connects, 1)
  first.socket.close()
  await until(() => disconnects === 1, 'initial disconnect')
  assert.equal(machines.hasSupervisor(machineId), false)
  await until(
    async () => (await machines.listMachines()).find((m) => m.id === machineId)?.online === false,
    'presence grace expires before offline approval',
    35_000,
  )
  updates.setTarget('dev', target)
  const offlineOperation = await start()
  assert.equal((await registry.sessionStore.operations.get(offlineOperation))?.state, 'done')
  assert.deepEqual(registry.sessionStore.operations.approvedTarget('dev'), target)
  assert.deepEqual(registry.modules.updatesReconciler?.pending(), [])

  // No fixture call to onMachineConnected/onOperationSettled/onFleetChanged:
  // only /machine dispatch and the production registry subscriptions can grant.
  const reconnected = await connect()
  await until(() => reconnected.grants().length === 1, 'settled approval catch-up grant')
  assert.deepEqual(reconnected.grants()[0]?.target, target)
  assert.equal(operations.engine.active('lifecycle'), undefined)
  reconnected.socket.send(
    JSON.stringify({
      type: 'updateStatus',
      grantId: reconnected.grants()[0]!.grantId,
      version: '1.0.0',
      targetVersion: target.version,
      state: 'rejected',
      detail: 'Invalid signature',
    }),
  )
  await until(
    async () => (await updates.fleet()).find((m) => m.id === machineId)?.state === 'rejected',
    'catch-up refusal',
  )

  const activeOperation = await start()
  await until(() => reconnected.grants().length === 2, 'operation grant')
  const grant = reconnected.grants()[1]!
  const read = async () => (await registry.sessionStore.operations.get(activeOperation))?.operation
  for (const percent of [10, 65]) {
    reconnected.socket.send(
      JSON.stringify({
        type: 'updateStatus',
        grantId: grant.grantId,
        version: '1.0.0',
        state: 'downloading',
        percent,
        phaseDetail: 'Preparing verified payload',
      }),
    )
    await until(
      async () =>
        (await read())?.steps?.some((s) =>
          s.places?.some((p) => p.id === machineId && p.percent === percent),
        ) === true,
      `persisted operation preparation ${percent}%`,
    )
  }
  reconnected.socket.send(
    JSON.stringify({
      type: 'updateStatus',
      grantId: grant.grantId,
      version: '1.0.0',
      targetVersion: target.version,
      state: 'rejected',
      detail: 'Invalid signature',
    }),
  )
  await until(async () => (await read())?.state === 'failed', 'prompt operation rejection')
  assert.notEqual((await read())?.error?.code, 'stalled')

  // Same machine, new sender. The old transport close must not emit a death.
  const replacement = await connect()
  const beforeStaleClose = disconnects
  reconnected.socket.close()
  await until(() => reconnected.socket.readyState === WebSocket.CLOSED, 'stale socket close')
  await Bun.sleep(50)
  assert.equal(disconnects, beforeStaleClose)
  assert.equal(machines.hasSupervisor(machineId), true)
  replacement.socket.close()
  await until(() => disconnects === beforeStaleClose + 1, 'current socket close')
  assert.equal(machines.hasSupervisor(machineId), false)

  // A publication with different exact bytes has no standing authorization.
  updates.setTarget('dev', { ...target, version: '3.0.0' })
  const unapproved = await connect()
  await until(
    () => registry.modules.updatesReconciler?.pending().length === 0,
    'unapproved reconnect drained',
    10_000,
  )
  assert.equal(unapproved.grants().length, 0)
  console.log(
    JSON.stringify({
      machineEvents: 'passed',
      connects,
      disconnects,
      checks: [
        'real gateway handshake',
        'zero-role settled catch-up',
        'exact approved target',
        'persisted preparation progress',
        'prompt rejected operation',
        'stale disconnect fence',
        'unapproved publication refused',
      ],
    }),
  )
} catch (error) {
  console.error('[machine-events] failure', error)
  process.exitCode = 1
} finally {
  const closeDeadline = setTimeout(() => {
    console.error('[machine-events] cleanup exceeded 8 seconds')
    process.exit(1)
  }, 8_000)
  console.error('[machine-events] cleaning up')
  for (const socket of sockets) socket.close()
  await until(
    () => sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
    'client sockets closed',
  )
  await transport.close()
  registry.dispose()
  console.error('[machine-events] transport closed')
  // Bun can retain the stop promise after upgraded requests, even after every
  // client is CLOSED. Verify the listener is actually released before exiting.
  void Promise.resolve(server.stop(true)).catch((error) => {
    console.error('[machine-events] native server stop failed', error)
    process.exitCode = 1
  })
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(server.port, '127.0.0.1', () => {
      probe.close((error) => error ? reject(error) : resolve())
    })
  })
  clearTimeout(closeDeadline)
}
process.exit(process.exitCode ?? 0)
