import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SocketHub } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../../apps/server/src/router'

type Scenario = 'g1' | 'g2' | 'g3' | 'g4a' | 'g4b' | 'g5' | 'g6' | 'g7' | 'g8' | 'g9' | 'g10'

interface MachineEvidence {
  primaryExited: boolean
  config: Record<string, unknown> | null
  connectivity: Record<string, unknown> | null
  sourceJournal: Record<string, unknown> | null
  transferStages: Array<Record<string, unknown>>
  machineId: string | null
  issueTitles: string[]
  health: boolean
  sentinels: {
    artifact: boolean
    transcript: boolean
    agentAfterTransfer: boolean
  }
  processes: string[]
}

const scenario = process.env.PODIUM_TRANSFER_SCENARIO as Scenario | undefined
if (
  !scenario ||
  !['g1', 'g2', 'g3', 'g4a', 'g4b', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10'].includes(scenario)
) {
  throw new Error(`unknown PODIUM_TRANSFER_SCENARIO: ${scenario ?? '(missing)'}`)
}

const sourceUrl = 'http://source:18787'
const targetUrl = 'http://target:18787'
const edgeUrl = 'http://edge:18787'
const repoPath = '/fixture-repo'

// A dropped promote reply is classified only after the production RPC's intentional 120s bound.
const PROMOTE_UNCERTAINTY_WAIT_MS = 150_000

function api(baseUrl: string): ReturnType<typeof createTRPCClient<AppRouter>> {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] })
}

async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (accept(last)) return last
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(50)
  }
  throw new Error(
    `timed out waiting for ${label}; last=${JSON.stringify(last)} error=${String(lastError)}`,
  )
}

async function health(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`)
    return response.ok && (await response.text()) === 'ok'
  } catch {
    return false
  }
}

function evidence(role: 'source' | 'target'): MachineEvidence {
  return JSON.parse(readFileSync(`/coord/${role}-evidence.json`, 'utf8')) as MachineEvidence
}

function writeCoord(name: string, value: string): void {
  const path = join('/coord', name)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, value)
  renameSync(temp, path)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function pairTarget(source: ReturnType<typeof api>) {
  const pairing = await source.machines.pairingCode.mutate()
  writeCoord('pair-code', `${pairing.code}\n`)
  return eventually(
    () => source.machines.list.query(),
    (machines) => machines.some((machine) => machine.name === 'transfer-target' && machine.online),
    'paired target daemon',
  ).then((machines) => {
    const target = machines.find((machine) => machine.name === 'transfer-target')
    if (!target) throw new Error('paired target disappeared')
    return target
  })
}

async function createLiveFixture(source: ReturnType<typeof api>) {
  const machines = await source.machines.list.query()
  const sourceMachine = machines.find((machine) => machine.name !== 'transfer-target')
  if (!sourceMachine) throw new Error('source host machine is missing')
  const agent = await source.sessions.create.mutate({
    agentKind: 'codex',
    cwd: repoPath,
    machineId: sourceMachine.id,
  })
  const agentSessionId = asSessionId(agent.sessionId)
  const shell = await source.sessions.create.mutate({
    agentKind: 'shell',
    cwd: repoPath,
    machineId: sourceMachine.id,
  })
  const sessionId = asSessionId(shell.sessionId)
  await eventually(
    () => source.sessions.list.query(),
    (sessions) =>
      sessions.some(
        (session) =>
          session.sessionId === agentSessionId &&
          session.agentKind === 'codex' &&
          session.status === 'live',
      ) && sessions.some((session) => session.sessionId === sessionId && session.status === 'live'),
    'live deterministic agent and durable shell sessions',
  )
  await source.issues.create.mutate({
    repoPath,
    title: `Docker transfer sentinel ${scenario}`,
    startNow: false,
  })
  return { agentSessionId, sessionId, sourceMachine }
}

async function successCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  const { agentSessionId, sessionId, sourceMachine } = await createLiveFixture(source)
  let output = ''
  let attaches = 0
  const hub = new SocketHub({
    url: 'ws://edge:18787/client',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    onError: (message) => console.error(`[transfer-fixture:native-client] ${message}`),
  })
  const connection = hub.attach(sessionId, {
    onFrame: (text) => {
      output += text
    },
    onAttached: () => {
      attaches += 1
    },
  })
  hub.connect()
  await eventually(
    () => attaches,
    (count) => count >= 1,
    'native client initial attach',
  )
  const transfer = source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  await eventually(
    () => existsSync('/coord/first-success-chunk-held'),
    Boolean,
    'initial snapshot upload hold',
  )

  const preCopyIssueTitle = 'Concurrent write committed during initial staging'
  connection.sendInput(
    `mkdir -p "$PODIUM_STATE_DIR/artifacts" "$PODIUM_STATE_DIR/transcripts"; ` +
      `printf artifact > "$PODIUM_STATE_DIR/artifacts/docker-transfer.txt"; ` +
      `printf transcript > "$PODIUM_STATE_DIR/transcripts/docker-transfer.txt"; ` +
      `printf '\\nSENTINELS_READY\\n'\n`,
  )
  await Promise.all([
    source.issues.create.mutate({
      repoPath,
      title: preCopyIssueTitle,
      startNow: false,
    }),
    eventually(
      () => evidence('source'),
      (value) => value.sentinels.artifact && value.sentinels.transcript,
      'concurrent source writes during initial staging',
    ),
  ])

  const started = await transfer
  const activeDuringCopy = await source.operations.active.query({ group: 'lifecycle' })
  assert(activeDuringCopy?.id === started.operationId, 'active operation id changed during copy')
  assert(
    activeDuringCopy.steps?.some((step) => step.id === 'stage' && step.state === 'running'),
    'generic operation did not expose the running copy step',
  )
  writeCoord('release-stage-chunk', String(Date.now()))
  assert(started.started, `server move did not start: ${JSON.stringify(started)}`)
  const completed = await eventually(
    () => api(targetUrl).operations.history.query({ kind: 'server-move', limit: 20 }),
    (history) =>
      history.some((entry) => entry.id === started.operationId && entry.state === 'done'),
    'target operation history completion',
  )
  await eventually(() => health(targetUrl), Boolean, 'promoted target health')
  const targetEvidence = await eventually(
    () => evidence('target'),
    (value) =>
      value.health &&
      value.config?.mode === 'server' &&
      value.sentinels.artifact &&
      value.sentinels.transcript &&
      value.issueTitles.some((title) => title.startsWith('Docker transfer sentinel ')) &&
      value.issueTitles.includes(preCopyIssueTitle),
    'target promotion and imported portable files',
  )
  if (scenario === 'g1') {
    assert(targetEvidence.config?.port === 18_787, 'target did not persist the explicit proof port')
  }
  const sourceEvidence = await eventually(
    () => evidence('source'),
    (value) =>
      value.primaryExited &&
      value.config?.mode === 'daemon' &&
      value.connectivity?.state === 'connected',
    'source daemon reconnection',
  )
  if (scenario === 'g2') {
    const record = sourceEvidence.sourceJournal?.record as Record<string, unknown> | undefined
    assert(record?.probe, 'concurrent pre-copy write did not force a final restage')
  }
  const targetApi = api(targetUrl)
  const importedSessions = await targetApi.sessions.list.query()
  assert(
    importedSessions.some((session) => session.sessionId === sessionId),
    'target did not import the durable session row',
  )
  assert(
    importedSessions.some(
      (session) => session.sessionId === agentSessionId && session.agentKind === 'codex',
    ),
    'target did not import the active agent row',
  )
  await eventually(
    () => targetApi.machines.list.query(),
    (machines) => machines.some((machine) => machine.id === sourceMachine.id && machine.online),
    'source machine online as daemon at target',
  )
  await eventually(
    () => targetApi.sessions.list.query(),
    (sessions) =>
      sessions.some(
        (session) => session.sessionId === agentSessionId && session.status === 'live',
      ) && sessions.some((session) => session.sessionId === sessionId && session.status === 'live'),
    'deterministic agent and durable shell live after source daemon reconnect',
  )
  await eventually(
    () => attaches,
    (count) => count >= 2,
    'native client reattach after cutover',
  )
  connection.sendInput(`printf reconnected > "$PODIUM_STATE_DIR/agent-after-transfer.txt"\n`)
  await eventually(
    () => evidence('source'),
    (value) => value.sentinels.agentAfterTransfer,
    'native client input executing on preserved source agent',
  )
  assert(
    output.includes('SENTINELS_READY'),
    'native client never observed pre-transfer shell output',
  )
  hub.dispose()
  return {
    started,
    completed,
    agentSessionId,
    sessionId,
    nativeClientAttaches: attaches,
    sourceMachineId: sourceMachine.id,
    targetMachineId: targetMachine.id,
    importedConcurrentWrite: preCopyIssueTitle,
    activeDuringCopy,
    sourceEvidence,
    targetEvidence,
  }
}

async function lostReplyCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  const { agentSessionId, sessionId } = await createLiveFixture(source)
  const started = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(started.started, `server move did not start: ${JSON.stringify(started)}`)
  const injectedMarker =
    scenario === 'g4a'
      ? 'promote-reply-dropped'
      : scenario === 'g4b'
        ? 'promote-request-dropped'
        : 'source-fault-once'
  await eventually(
    () => existsSync(`/coord/${injectedMarker}`),
    Boolean,
    'promotion uncertainty fault injection',
  )
  const uncertain = await eventually(
    () => source.operations.active.query({ group: 'lifecycle' }),
    (operation) =>
      operation?.id === started.operationId &&
      operation.state === 'waiting' &&
      operation.awaiting?.some((ask) => ask.id === 'server-move-recovery')
        ? operation
        : undefined,
    'generic uncertain operation projection',
    PROMOTE_UNCERTAINTY_WAIT_MS,
  )
  const sourceEvidence = await eventually(
    () => evidence('source'),
    (value) => value.sourceJournal?.state === 'commit-uncertain',
    'source commit-uncertain journal',
    PROMOTE_UNCERTAINTY_WAIT_MS,
  )
  let sourceWriteRejected = false
  try {
    await source.issues.create.mutate({
      repoPath,
      title: 'Must remain fenced',
      startNow: false,
    })
  } catch {
    sourceWriteRejected = true
  }
  assert(sourceWriteRejected, 'source accepted a write after a lost commit reply')
  assert(await health(sourceUrl), 'fenced source lost its recovery/read surface')
  if (scenario !== 'g4b')
    assert(await health(targetUrl), 'target did not remain healthy after promotion')
  assert(sourceEvidence.config?.mode !== 'daemon', 'uncertain source silently switched to daemon')

  await eventually(
    () => evidence('target'),
    (value) => value.connectivity?.state === 'connected',
    'target control channel reconnect for recovery',
  )
  const recoveredOutcome = await source.operations.settleAsk.mutate({
    id: started.operationId,
    actionId: 'server-move-recovery',
  })
  assert(
    recoveredOutcome.handled,
    `generic recovery was refused: ${JSON.stringify(recoveredOutcome)}`,
  )
  const recoveredSourceEvidence = await eventually(
    () => evidence('source'),
    (value) =>
      value.primaryExited &&
      value.config?.mode === 'daemon' &&
      value.connectivity?.state === 'connected',
    'source daemon reconnection after lost-reply recovery',
  )
  const targetEvidence = await eventually(
    () => evidence('target'),
    (value) => value.health && value.config?.mode === 'server',
    'promoted target after uncertainty recovery',
  )
  const targetApi = api(targetUrl)
  assert(
    (await targetApi.sessions.list.query()).some((session) => session.sessionId === sessionId),
    'promoted target lost the durable session during commit uncertainty',
  )
  assert(
    (await targetApi.sessions.list.query()).some(
      (session) => session.sessionId === agentSessionId && session.agentKind === 'codex',
    ),
    'promoted target lost the active agent row during commit uncertainty',
  )
  if (scenario === 'g4b')
    assert(existsSync('/coord/promote-replay-identical'), 'recovery did not replay exact promote')
  if (scenario === 'g5')
    assert(existsSync('/coord/ack-after-commit'), 'target acknowledgement preceded journal commit')
  await eventually(
    () => targetApi.sessions.list.query(),
    (sessions) =>
      sessions.some(
        (session) => session.sessionId === agentSessionId && session.status === 'live',
      ) && sessions.some((session) => session.sessionId === sessionId && session.status === 'live'),
    'deterministic agent and durable shell live after lost-reply recovery',
  )
  return {
    started,
    uncertain,
    recoveredOutcome,
    sessionId,
    sourceEvidence,
    recoveredSourceEvidence,
    targetEvidence,
    targetMachineId: targetMachine.id,
  }
}

async function waitForTargetDone(operationId: string) {
  return eventually(
    () => api(targetUrl).operations.history.query({ kind: 'server-move', limit: 20 }),
    (history) => history.find((entry) => entry.id === operationId && entry.state === 'done'),
    'target operation completion',
  )
}

async function waitForSourceDaemon() {
  return eventually(
    () => evidence('source'),
    (value) =>
      value.primaryExited &&
      value.config?.mode === 'daemon' &&
      value.connectivity?.state === 'connected',
    'source daemon handoff',
  )
}

async function fenceWriteCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  await createLiveFixture(source)
  const started = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(started.started, `server move did not start: ${JSON.stringify(started)}`)
  await eventually(
    () => existsSync('/coord/promote-request-held'),
    Boolean,
    'held promote request after source fence',
  )
  const projected = await source.operations.active.query({ group: 'lifecycle' })
  assert(projected?.id === started.operationId, 'projected operation id changed during fence')
  assert(
    projected.steps?.some((step) => step.id === 'fence' && step.state === 'done'),
    'source-fenced projection did not advance the fence step',
  )
  assert(
    projected.steps?.some((step) => step.id === 'cutover' && step.state === 'running'),
    'committing projection did not expose the running cutover step',
  )
  assert(
    !projected.awaiting?.some((ask) => ask.id === 'server-move-recovery'),
    'live fence runner incorrectly offered recovery',
  )
  let writeRejected = false
  try {
    await source.issues.create.mutate({
      repoPath,
      title: 'Must not land after source fence',
      startNow: false,
    })
  } catch {
    writeRejected = true
  }
  assert(writeRejected, 'a durable write landed after source-fenced')
  writeCoord('release-promote', String(Date.now()))
  const done = await waitForTargetDone(started.operationId)
  return {
    started,
    projected,
    done,
    sourceEvidence: await waitForSourceDaemon(),
    targetEvidence: await eventually(
      () => evidence('target'),
      (value) => value.health && value.config?.mode === 'server',
      'target serving the fenced snapshot',
    ),
  }
}

async function cancelCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  const { sessionId } = await createLiveFixture(source)
  const started = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(started.started, `server move did not start: ${JSON.stringify(started)}`)
  await eventually(
    () => existsSync('/coord/first-success-chunk-held'),
    Boolean,
    'held stage chunk for cancellation',
  )
  const active = await source.operations.active.query({ group: 'lifecycle' })
  assert(
    active?.steps?.some((step) => step.id === 'stage' && step.state === 'running'),
    'cancel did not land during the reversible stage step',
  )
  const canceling = source.operations.cancel.mutate({ id: started.operationId })
  writeCoord('release-stage-chunk', String(Date.now()))
  const canceled = await canceling
  assert(canceled.canceled, `generic cancel was refused: ${JSON.stringify(canceled)}`)
  const history = await eventually(
    () => source.operations.history.query({ kind: 'server-move', limit: 20 }),
    (rows) => rows.find((entry) => entry.id === started.operationId && entry.state === 'canceled'),
    'canceled server move history',
  )
  const sourceEvidence = await eventually(
    () => evidence('source'),
    (value) => value.sourceJournal?.state === 'aborted',
    'aborted journal after stage cancellation',
  )
  await eventually(
    () => evidence('target'),
    (value) => value.transferStages.length === 0,
    'target cleanup after cancellation',
  )
  assert(
    (await source.sessions.list.query()).some(
      (session) => session.sessionId === sessionId && session.status === 'live',
    ),
    'live shell did not survive pre-fence cancellation',
  )
  return { started, active, canceled, history, sourceEvidence, sessionId }
}

async function retryCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  await createLiveFixture(source)
  const first = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(first.started, `first server move did not start: ${JSON.stringify(first)}`)
  const failed = await eventually(
    () => source.operations.history.query({ kind: 'server-move', limit: 20 }),
    (rows) => rows.find((entry) => entry.id === first.operationId && entry.state === 'failed'),
    'first move validation failure',
  )
  const second = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(second.started, `retry server move did not start: ${JSON.stringify(second)}`)
  const done = await waitForTargetDone(second.operationId)
  assert(done.retryOf === first.operationId, 'fresh retry did not link to the failed operation')
  return { first, failed, second, done, sourceEvidence: await waitForSourceDaemon() }
}

async function restartResumeCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  await createLiveFixture(source)
  const started = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(started.started, `server move did not start: ${JSON.stringify(started)}`)
  await eventually(
    () => existsSync('/coord/midstage-reply-held'),
    Boolean,
    'target accepted a chunk before source restart',
  )
  writeCoord('restart-source', String(Date.now()))
  await eventually(
    () => existsSync('/coord/restart-source-ack'),
    Boolean,
    'source supervisor restart acknowledgement',
  )
  await eventually(() => health(sourceUrl), Boolean, 'source health after mid-stage restart')
  await eventually(
    () => existsSync('/coord/resume-received-bytes'),
    Boolean,
    'target received-byte resume proof',
  )
  const done = await waitForTargetDone(started.operationId)
  return {
    started,
    done,
    resumedBytes: readFileSync('/coord/resume-received-bytes', 'utf8').trim(),
    sourceEvidence: await waitForSourceDaemon(),
  }
}

async function reclaimCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  await createLiveFixture(source)
  const first = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(first.started, `server move did not start: ${JSON.stringify(first)}`)
  const failed = await eventually(
    () => source.operations.history.query({ kind: 'server-move', limit: 20 }),
    (rows) => rows.find((entry) => entry.id === first.operationId && entry.state === 'failed'),
    'post-seal reclaimed failure',
  )
  const sourceEvidence = await eventually(
    () => evidence('source'),
    (value) => value.sourceJournal?.state === 'aborted',
    'writable aborted source after reclaim',
  )
  assert(await health(sourceUrl), 'source was not writable after reclaimed handoff')
  assert(!existsSync('/coord/promote-observed'), 'failed move sent a promote request')
  assert(
    (await evidence('target')).transferStages.length === 0,
    'reclaim left the failed target stage behind',
  )
  const second = await source.machines.moveServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: 'TRANSFER SERVER',
  })
  assert(second.started, `fresh move after reclaim did not start: ${JSON.stringify(second)}`)
  const done = await waitForTargetDone(second.operationId)
  assert(done.retryOf === first.operationId, 'post-reclaim retry did not link history')
  return { first, failed, sourceEvidence, second, done }
}

await eventually(() => health(sourceUrl), Boolean, 'source all-in-one health')
await eventually(() => health(edgeUrl), Boolean, 'stable edge health')
const source = api(sourceUrl)
const targetMachine = await pairTarget(source)
const result = await (async () => {
  if (scenario === 'g1' || scenario === 'g2' || scenario === 'g9')
    return successCase(source, targetMachine)
  if (scenario === 'g3') return fenceWriteCase(source, targetMachine)
  if (scenario === 'g4a' || scenario === 'g4b' || scenario === 'g5')
    return lostReplyCase(source, targetMachine)
  if (scenario === 'g6') return cancelCase(source, targetMachine)
  if (scenario === 'g7') return retryCase(source, targetMachine)
  if (scenario === 'g8') return restartResumeCase(source, targetMachine)
  return reclaimCase(source, targetMachine)
})()

console.log(`TRANSFER_EVIDENCE ${JSON.stringify({ scenario, ...result })}`)
