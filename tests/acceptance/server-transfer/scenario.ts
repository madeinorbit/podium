import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SocketHub } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../../apps/server/src/router'

type Scenario = 'success' | 'precommit-abort' | 'lost-commit-reply'

interface MachineEvidence {
  primaryExited: boolean
  config: Record<string, unknown> | null
  connectivity: Record<string, unknown> | null
  sourceJournal: Record<string, unknown> | null
  transferStages: Array<Record<string, unknown>>
  machineId: string | null
  health: boolean
  sentinels: {
    artifact: boolean
    transcript: boolean
    agentAfterTransfer: boolean
  }
  processes: string[]
}

const scenario = process.env.PODIUM_TRANSFER_SCENARIO as Scenario | undefined
if (!scenario || !['success', 'precommit-abort', 'lost-commit-reply'].includes(scenario)) {
  throw new Error(`unknown PODIUM_TRANSFER_SCENARIO: ${scenario ?? '(missing)'}`)
}

const sourceUrl = 'http://source:18787'
const targetUrl = 'http://target:18787'
const edgeUrl = 'http://edge:18787'
const repoPath = '/fixture-repo'

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
  const created = await source.sessions.create.mutate({
    agentKind: 'shell',
    cwd: repoPath,
    machineId: sourceMachine.id,
  })
  const sessionId = asSessionId(created.sessionId)
  await eventually(
    () => source.sessions.list.query(),
    (sessions) =>
      sessions.some((session) => session.sessionId === sessionId && session.status === 'live'),
    'live durable shell session',
  )
  await source.issues.create.mutate({
    repoPath,
    title: `Docker transfer sentinel ${scenario}`,
    startNow: false,
  })
  return { sessionId, sourceMachine }
}

async function successCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  const { sessionId, sourceMachine } = await createLiveFixture(source)
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
  const preCopyIssueTitle = 'Concurrent write committed before portable snapshot'
  const preCopyIssueWrite = source.issues.create.mutate({
    repoPath,
    title: preCopyIssueTitle,
    startNow: false,
  })
  connection.sendInput(
    `mkdir -p "$PODIUM_STATE_DIR/artifacts" "$PODIUM_STATE_DIR/transcripts"; ` +
      `printf artifact > "$PODIUM_STATE_DIR/artifacts/docker-transfer.txt"; ` +
      `printf transcript > "$PODIUM_STATE_DIR/transcripts/docker-transfer.txt"; ` +
      `printf '\\nSENTINELS_READY\\n'\n`,
  )
  await Promise.all([
    preCopyIssueWrite,
    eventually(
      () => evidence('source'),
      (value) => value.sentinels.artifact && value.sentinels.transcript,
      'concurrent source writes before portable snapshot',
    ),
  ])

  const outcome = await source.machines.transferServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: true,
  })
  assert(
    outcome.ok && outcome.state === 'committed',
    `transfer did not commit: ${JSON.stringify(outcome)}`,
  )
  await eventually(() => health(targetUrl), Boolean, 'promoted target health')
  const targetEvidence = await eventually(
    () => evidence('target'),
    (value) =>
      value.health &&
      value.config?.mode === 'server' &&
      value.sentinels.artifact &&
      value.sentinels.transcript,
    'target promotion and imported portable files',
  )
  const sourceEvidence = await eventually(
    () => evidence('source'),
    (value) =>
      value.primaryExited &&
      value.config?.mode === 'daemon' &&
      value.connectivity?.state === 'connected',
    'source daemon reconnection',
  )
  const targetApi = api(targetUrl)
  const importedSessions = await targetApi.sessions.list.query()
  assert(
    importedSessions.some((session) => session.sessionId === sessionId),
    'target did not import the durable session row',
  )
  const importedIssues = await targetApi.issues.list.query({ repoPath })
  assert(
    importedIssues.some((issue) => issue.title === `Docker transfer sentinel ${scenario}`),
    'target did not import the issue sentinel',
  )
  assert(
    importedIssues.some((issue) => issue.title === preCopyIssueTitle),
    'target did not import the concurrent pre-copy write',
  )
  await eventually(
    () => targetApi.machines.list.query(),
    (machines) => machines.some((machine) => machine.id === sourceMachine.id && machine.online),
    'source machine online as daemon at target',
  )
  await eventually(
    () => targetApi.sessions.list.query(),
    (sessions) =>
      sessions.some((session) => session.sessionId === sessionId && session.status === 'live'),
    'durable shell live after source daemon reconnect',
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
    outcome,
    sessionId,
    nativeClientAttaches: attaches,
    sourceMachineId: sourceMachine.id,
    targetMachineId: targetMachine.id,
    importedConcurrentWrite: preCopyIssueTitle,
    sourceEvidence,
    targetEvidence,
  }
}

async function precommitAbortCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  await createLiveFixture(source)
  let rejected = false
  try {
    await source.machines.transferServer.mutate({
      targetMachineId: targetMachine.id,
      publicUrl: edgeUrl,
      confirmation: true,
    })
  } catch (error) {
    rejected = true
    console.log(`[transfer-fixture:precommit-abort] expected rejection: ${String(error)}`)
  }
  assert(existsSync('/coord/validation-digest-corrupted'), 'validation fault was not injected')
  assert(rejected, 'corrupted target validation unexpectedly committed')
  const sourceEvidence = await eventually(
    () => evidence('source'),
    (value) => value.sourceJournal?.state === 'aborted',
    'source aborted journal after target validation failure',
  )
  const targetEvidence = await eventually(
    () => evidence('target'),
    (value) => value.transferStages.length === 0,
    'target staging cleanup after digest failure',
  )
  assert(await health(sourceUrl), 'source stopped serving after a pre-commit abort')
  assert(!(await health(targetUrl)), 'target became a server during a pre-commit abort')
  assert(targetEvidence.config?.mode !== 'server', 'target config switched during abort')
  await source.issues.create.mutate({
    repoPath,
    title: 'Source writable after abort',
    startNow: false,
  })
  return {
    injectedFault: 'validation manifest digest mismatch',
    sourceEvidence,
    targetEvidence,
    targetMachineId: targetMachine.id,
  }
}

async function lostReplyCase(
  source: ReturnType<typeof api>,
  targetMachine: Awaited<ReturnType<typeof pairTarget>>,
): Promise<Record<string, unknown>> {
  const { sessionId } = await createLiveFixture(source)
  const outcome = await source.machines.transferServer.mutate({
    targetMachineId: targetMachine.id,
    publicUrl: edgeUrl,
    confirmation: true,
  })
  assert(existsSync('/coord/promote-reply-dropped'), 'commit reply fault was not injected')
  assert(
    !outcome.ok && outcome.state === 'commit-uncertain',
    `lost commit reply was not fenced uncertain: ${JSON.stringify(outcome)}`,
  )
  const sourceEvidence = await eventually(
    () => evidence('source'),
    (value) => value.sourceJournal?.state === 'commit-uncertain',
    'source commit-uncertain journal',
  )
  const targetEvidence = await eventually(
    () => evidence('target'),
    (value) => value.health && value.config?.mode === 'server',
    'promoted target after lost reply',
  )
  const targetApi = api(targetUrl)
  assert(
    (await targetApi.sessions.list.query()).some((session) => session.sessionId === sessionId),
    'promoted target lost the durable session during commit uncertainty',
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
  assert(await health(targetUrl), 'target did not remain healthy after promotion')
  assert(sourceEvidence.config?.mode !== 'daemon', 'uncertain source silently switched to daemon')
  return { outcome, sessionId, sourceEvidence, targetEvidence, targetMachineId: targetMachine.id }
}

await eventually(() => health(sourceUrl), Boolean, 'source all-in-one health')
await eventually(() => health(edgeUrl), Boolean, 'stable edge health')
const source = api(sourceUrl)
const targetMachine = await pairTarget(source)
const result =
  scenario === 'success'
    ? await successCase(source, targetMachine)
    : scenario === 'precommit-abort'
      ? await precommitAbortCase(source, targetMachine)
      : await lostReplyCase(source, targetMachine)

console.log(`TRANSFER_EVIDENCE ${JSON.stringify({ scenario, ...result })}`)
