/**
 * Real grok-acp A1b superseding proof for POD-2927.
 *
 * This talks to the isolated production server through the same tRPC caller and
 * websocket transcript used by the web product. It creates a real provider
 * session, proves a durable active turn is working, queues a second turn, drops
 * and recreates the caller, and reads the queue position back from the durable
 * messages.ledger projection before following the turn to its exact reply.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  AGENT_KIND,
  Chat,
  login,
  mutate,
  nonce,
  now,
  query,
  sessionRow,
  until,
  wait,
} from '../pod-2777/rig'

type DriverName = 'grok'
type LedgerRow = {
  id: string
  body: string
  status: string
  queuePosition?: number
  injectedAt?: string | null
  deliveredAt?: string | null
}

const driver = process.argv[2] as DriverName | undefined
if (driver !== 'grok') {
  throw new Error('usage: a1b-runtime.ts grok')
}

const evidenceDir = process.env.POD2927_EVIDENCE ?? import.meta.dir
const base = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2927-grok-current'
const cwd = resolve(base, 'probes', `${driver}-a1b-superseding-5a`)
const expectedDriver = 'grok-acp'
const expectedFamily = 'server'
const startedAt = new Date().toISOString()
const monotonicStart = now()

function hostSnapshot() {
  const load = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).map(Number)
  const mem = readFileSync('/proc/meminfo', 'utf8')
  const memAvailableKb = Number(/^MemAvailable:\s+(\d+)/m.exec(mem)?.[1] ?? 0)
  const disk = spawnSync('df', ['-Pk', '/'], { encoding: 'utf8' }).stdout.trim().split('\n').at(-1)?.split(/\s+/) ?? []
  return { load, memAvailableKb, rootFreeKb: Number(disk[3] ?? 0) }
}

function verifyPins() {
  const result = spawnSync('bash', [resolve(evidenceDir, 'verify-a1b.sh')], {
    cwd,
    env: process.env,
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) throw new Error(`pin verification refused:\n${output}`)
  const line = output.split('\n').find((value) => value.startsWith('PINJSON '))
  if (!line) throw new Error(`pin verification returned no PINJSON:\n${output}`)
  return JSON.parse(line.slice('PINJSON '.length)) as Record<string, unknown>
}

async function ledgerRows(sessionId: string): Promise<LedgerRow[]> {
  const response = await query('messages.ledger', { sessionId, limit: 100 })
  return (response.result?.data ?? []) as LedgerRow[]
}

async function waitForLedger(sessionId: string, marker: string, timeoutMs: number) {
  const deadline = now() + timeoutMs
  let row: LedgerRow | undefined
  while (now() < deadline) {
    row = (await ledgerRows(sessionId)).find((candidate) => candidate.body.includes(marker))
    if (row) return row
    await wait(200)
  }
  return row
}

async function waitForExactReply(chat: Chat, token: string, timeoutMs: number) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    const replies = chat.items
      .filter((item) => item.role === 'assistant')
      .map((item) => item.text.trim())
      .filter(Boolean)
    const exact = replies.find((reply) => reply === token)
    if (exact) return { exact, replies }
    await wait(500)
  }
  return {
    exact: undefined,
    replies: chat.items
      .filter((item) => item.role === 'assistant')
      .map((item) => item.text.trim())
      .filter(Boolean),
  }
}

const pins = verifyPins()
const hostAtStart = hostSnapshot()
if (hostAtStart.load[0] >= 12) throw new Error(`load1 ${hostAtStart.load[0]} is not admissible`)
if (hostAtStart.rootFreeKb < 5 * 1024 * 1024) throw new Error(`root free ${hostAtStart.rootFreeKb}kB is below 5GiB floor`)

await login()
const created = await mutate('sessions.create', { cwd, agentKind: AGENT_KIND[driver] })
const sessionId = created.result?.data?.sessionId as string | undefined
if (!sessionId) throw new Error(`sessions.create failed: ${JSON.stringify(created).slice(0, 800)}`)

let caller: Chat | undefined
let reloadedCaller: Chat | undefined
let result: Record<string, unknown> | undefined
try {
  const bound = await until(
    sessionId,
    (row) => Boolean(row?.driverId) || row?.status === 'exited',
    120_000,
    500,
  )
  const productDriver = bound.row ?? (await sessionRow(sessionId))
  if (productDriver?.status === 'exited') {
    throw new Error(`real ${driver} session exited: ${JSON.stringify(productDriver)}`)
  }
  if (productDriver?.driverId !== expectedDriver || productDriver?.driverFamily !== expectedFamily) {
    throw new Error(
      `wrong production driver: ${productDriver?.driverId}/${productDriver?.driverFamily}; expected ${expectedDriver}/${expectedFamily}`,
    )
  }

  caller = new Chat(sessionId)
  await caller.open('chat')
  const settled = await until(sessionId, (row) => row?.agentState?.phase !== 'working', 120_000, 500)
  if (!settled.ok) throw new Error('session never reached a non-working starting boundary')

  const controlToken = nonce(`P2927-${driver.toUpperCase()}-CONTROL`)
  const controlPrompt = `Count from 1 through 120, one number per line, then write exactly ${controlToken} on its own final line. Do not use tools.`
  const controlReceipt = await mutate('sessions.sendText', { sessionId, text: controlPrompt })
  const working = await until(sessionId, (row) => row?.agentState?.phase === 'working', 60_000, 100)
  const durableControl = await (async () => {
    const deadline = now() + 20_000
    while (now() < deadline) {
      if (caller?.userText().includes(controlToken)) return true
      await wait(100)
    }
    return false
  })()
  if (!working.ok || !durableControl) {
    throw new Error(`positive control failed: working=${working.ok} durable=${durableControl}`)
  }

  const replyToken = nonce(`P2927-${driver.toUpperCase()}-QUEUED-REPLY`)
  const queuedPrompt = `Reply with exactly ${replyToken} and nothing else. Do not use tools.`
  const queuedResponse = await mutate('sessions.sendText', { sessionId, text: queuedPrompt })
  const receipt = queuedResponse.result?.data as Record<string, unknown> | undefined
  const receiptPosition = Number(receipt?.position)
  if (
    receipt?.ok !== true ||
    receipt?.queued !== true ||
    receipt?.disposition !== 'queued' ||
    !Number.isInteger(receiptPosition) ||
    receiptPosition < 1
  ) {
    throw new Error(`caller receipt was not queued with a physical position: ${JSON.stringify(queuedResponse)}`)
  }

  const beforeReload = await waitForLedger(sessionId, replyToken, 20_000)
  if (
    beforeReload?.status !== 'queued' ||
    beforeReload.queuePosition !== receiptPosition
  ) {
    throw new Error(
      `durable pre-reload row disagreed with caller receipt: ${JSON.stringify(beforeReload)}`,
    )
  }

  await caller.close()
  caller = undefined
  await login()
  reloadedCaller = new Chat(sessionId)
  await reloadedCaller.open('chat')
  const afterReload = await waitForLedger(sessionId, replyToken, 20_000)
  if (
    afterReload?.id !== beforeReload.id ||
    afterReload.status !== 'queued' ||
    afterReload.queuePosition !== receiptPosition
  ) {
    throw new Error(
      `durable reload lost or changed the queue position: ${JSON.stringify({ beforeReload, afterReload })}`,
    )
  }

  const deliveredDeadline = now() + 300_000
  let delivered: LedgerRow | undefined
  while (now() < deliveredDeadline) {
    delivered = (await ledgerRows(sessionId)).find((candidate) => candidate.id === beforeReload.id)
    if (delivered?.status === 'delivered') break
    await wait(500)
  }
  if (delivered?.status !== 'delivered') {
    throw new Error(`queued turn did not reach delivered ledger state: ${JSON.stringify(delivered)}`)
  }

  const exactReply = await waitForExactReply(reloadedCaller, replyToken, 120_000)
  if (exactReply.exact !== replyToken) {
    throw new Error(`queued turn did not get exact requested reply: ${JSON.stringify(exactReply.replies)}`)
  }
  const finalRow = await sessionRow(sessionId)
  if (finalRow?.agentState?.phase === 'working') {
    const idle = await until(sessionId, (row) => row?.agentState?.phase !== 'working', 60_000, 250)
    if (!idle.ok) throw new Error('active turn did not settle after queued delivery')
  }

  result = {
    verdict: 'PASS',
    driverRequested: driver,
    productDriverId: productDriver.driverId,
    productDriverFamily: productDriver.driverFamily,
    sessionId,
    cwd,
    pins,
    hostAtStart,
    control: {
      receipt: controlReceipt.result?.data ?? controlReceipt.error ?? null,
      durableUserTurn: durableControl,
      phaseWorking: working.ok,
      token: controlToken,
    },
    queued: {
      callerReceipt: receipt,
      physicalPosition: receiptPosition,
      durableBeforeReload: beforeReload,
      durableAfterReload: afterReload,
      delivered,
      requestedReply: replyToken,
      exactReply: exactReply.exact,
    },
    isolation: {
      instance: process.env.PODIUM_INSTANCE,
      uniqueCwd: cwd,
      genericPtyOverride: process.env.PODIUM_RUNTIME_DRIVER ?? null,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: now() - monotonicStart,
  }
} finally {
  await caller?.close().catch(() => {})
  await reloadedCaller?.close().catch(() => {})
  await mutate('sessions.kill', { sessionId }).catch(() => {})
}

if (!result) throw new Error('runtime proof ended without a result')
const output = resolve(evidenceDir, 'readings', `${driver}-a1b-superseding.json`)
await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(`A1b ${driver} PASS`)
console.log(`driver=${result.productDriverId} family=${result.productDriverFamily}`)
console.log(`evidence=${output}`)
