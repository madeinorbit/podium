/** Production machine gateway + registry composition, isolated by the parent test. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { asMachineId } from '@podium/model'
import { createHandshakeDialer, type UpdateGrantMessage, type UpdateTarget } from '@podium/protocol'
import { SessionRegistry } from '../../apps/server/src/relay'
import { attachWebSockets, serveNative } from '../../apps/server/src/gateway/ws-server'
import type { UpdateOperationContext } from '../../apps/server/src/modules/updates/operation'

const registry = new SessionRegistry(undefined, undefined, { instanceId: 'blue' })
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
  fetch: (request, native) =>
    transport.handleRequest(request, native) ?? new Response('not found', { status: 404 }),
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
async function until(check: () => boolean, label: string, timeout = 5000) {
  const end = Date.now() + timeout
  while (!check()) {
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
  socket.send(
    JSON.stringify({
      type: 'machineReport',
      services: {
        crashOwner: 'desktop',
        server: { policy: 'disabled', state: 'stopped' },
        agentExecution: { policy: 'disabled', state: 'stopped' },
      },
    }),
  )
  await until(
    () =>
      machines.listMachines().find((m) => m.id === machineId)?.services?.server.state === 'stopped',
    'zero-role report',
  )
  return {
    socket,
    frames,
    grants: () => frames.filter((f) => f.type === 'updateGrant') as unknown as UpdateGrantMessage[],
  }
}
async function start() {
  const result = await operations.engine.start('update', context, { createdBy: 'user' })
  assert(result.started, JSON.stringify(result))
  await operations.engine.whenSettled(result.operation.id)
  return result.operation.id
}
try {
  const first = await connect()
  assert.equal(connects, 1)
  first.socket.close()
  await until(() => disconnects === 1, 'initial disconnect')
  assert.equal(machines.hasSupervisor(machineId), false)
  await until(
    () => machines.listMachines().find((m) => m.id === machineId)?.online === false,
    'presence grace expires before offline approval',
    35_000,
  )
  updates.setTarget('dev', target)
  const offlineOperation = await start()
  assert.equal(registry.sessionStore.operations.get(offlineOperation)?.state, 'done')
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
    () => updates.fleet().find((m) => m.id === machineId)?.state === 'rejected',
    'catch-up refusal',
  )

  const activeOperation = await start()
  await until(() => reconnected.grants().length === 2, 'operation grant')
  const grant = reconnected.grants()[1]!
  const read = () => registry.sessionStore.operations.get(activeOperation)?.operation
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
      () =>
        read()?.steps?.some((s) =>
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
  await until(() => read()?.state === 'failed', 'prompt operation rejection')
  assert.notEqual(read()?.error?.code, 'stalled')

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
} finally {
  for (const socket of sockets) socket.close()
  await transport.close()
  await server.stop(true)
  registry.dispose()
}
process.exit(0)
