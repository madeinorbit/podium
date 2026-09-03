/**
 * POD-2871 — prove that one terminal session cannot read another session's
 * OpenCode conversation.
 *
 * This is intentionally a live probe, not a fixture. It creates a healthy
 * companion and a fault session in the SAME cwd, leaves the companion alive,
 * and reads both the returned transcript content and the exact OpenCode rows
 * for each Podium session. It then repeats the content-and-row measurement for
 * two healthy sessions in DIFFERENT cwds.
 *
 * Run only after the instance has been brought up in the terminal arm; this
 * file does not start an instance. The retired model below is the known
 * accepted-then-never-settles OpenCode fault from POD-2811/POD-2604.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { opencodeSessionDbPath } from '../../../packages/harness/src/opencode/db'
import {
  AGENT_KIND,
  BASE,
  Chat,
  DRIVE_BASE,
  REPO,
  login,
  mutate,
  nonce,
  sessionRow,
  until,
  untilText,
  wait,
} from '../pod-2777/rig'

const HARNESS = process.env.P2871_HARNESS ?? 'opencode'
const EXPECTED_DRIVER = process.env.P2871_EXPECTED_DRIVER ?? 'generic-pty'
const EXPECTED_DRIVER_FAMILY = process.env.P2871_EXPECTED_DRIVER_FAMILY ?? 'terminal'
const ARM = process.env.P2871_ARM ?? 'with-fix'
if (ARM !== 'pre-fix' && ARM !== 'with-fix') throw new Error(`unknown P2871_ARM: ${ARM}`)
const EXPECTS_ISOLATION = ARM === 'with-fix'
const FAULT_MODEL = process.env.P2871_FAULT_MODEL ?? 'opencode/laguna-s-2.1-free'
const STORE_WAIT_MS = positiveMs('P2871_STORE_WAIT_MS', 30_000)
const ANSWER_WAIT_MS = positiveMs('P2871_ANSWER_WAIT_MS', 120_000)
const TERMINAL_READY_WAIT_MS = positiveMs('P2871_TERMINAL_READY_WAIT_MS', 60_000)
const STATE_DIR = process.env.P2777_STATE_ROOT
if (!STATE_DIR) throw new Error('source docs/evidence/pod-2811/drive-env.sh first')

const AGENT_HOME = join(STATE_DIR, 'agent-home')
const LEGACY_DB = join(AGENT_HOME, '.local', 'share', 'opencode', 'opencode.db')
// Keep these outside the scratch repo: the daemon deliberately reports a git
// subdirectory as that repo's worktree root, which would collapse this edge
// back into the same cwd. These are two real, non-git working directories.
const LEFT_CWD = join(DRIVE_BASE, 'pod-2871-left-cwd')
const OTHER_CWD = join(DRIVE_BASE, 'pod-2871-other-cwd')
const OUT = join(DRIVE_BASE, 'transcript-isolation')

function positiveMs(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

type StoreCounts = {
  sessionRows: number
  messageRows: number
  userRows: number
  assistantRows: number
  partRows: number
}

type StoreReading = {
  layout: 'session-owned' | 'legacy-shared'
  path: string
  querySessionId: string
  selectionReason: string
  counts?: StoreCounts
  error?: string
}

type Session = {
  sid: string
  cwd: string
  actualCwd: string
  driverId: string
  driverFamily: string
  requestedDriverId?: string
  nativeSessionId?: string
  chat: Chat
  startupScreen?: string
  store?: StoreReading
}
type MeasuredSession = Session & { nativeSessionId: string; store: StoreReading }

type CaseResult = {
  name: string
  sessions: Array<{
    sid: string
    cwd: string
    actualCwd: string
    driverId: string
    driverFamily: string
    requestedDriverId?: string
    nativeSessionId: string
    assistantText: string
    screenTail?: string
    startupScreen?: string
    store: StoreReading
  }>
  failures: string[]
  assertions: string[]
}

const sessions: string[] = []
const chats: Chat[] = []

function assertThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

function check(failures: string[], condition: unknown, message: string): void {
  if (!condition) failures.push(message)
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value)
}

function rowRole(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = (value as { data?: unknown }).data
  if (typeof data !== 'string') return undefined
  try {
    const parsed = JSON.parse(data) as { role?: unknown }
    return typeof parsed.role === 'string' ? parsed.role : undefined
  } catch {
    return undefined
  }
}

function readStore(
  path: string,
  layout: StoreReading['layout'],
  querySessionId: string,
  selectionReason: string,
): StoreReading {
  const reading: StoreReading = { layout, path, querySessionId, selectionReason }
  if (!existsSync(path)) return reading

  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(path, { readOnly: true })
    const sessionRows = db
      .prepare('SELECT id FROM session WHERE id = ?')
      .all(querySessionId) as unknown[]
    const messages = db
      .prepare('SELECT data FROM message WHERE session_id = ?')
      .all(querySessionId) as unknown[]
    const parts = db
      .prepare('SELECT id FROM part WHERE session_id = ?')
      .all(querySessionId) as unknown[]
    reading.counts = {
      sessionRows: sessionRows.length,
      messageRows: messages.length,
      userRows: messages.filter((row) => rowRole(row) === 'user').length,
      assistantRows: messages.filter((row) => rowRole(row) === 'assistant').length,
      partRows: parts.length,
    }
  } catch (error) {
    reading.error = String(error)
  } finally {
    db?.close()
  }
  return reading
}

function storeSessionIdsForPartText(path: string, text: string): string[] {
  if (!existsSync(path)) return []

  let db: ReturnType<typeof openDatabase> | undefined
  try {
    db = openDatabase(path, { readOnly: true })
    const rows = db
      .prepare('SELECT session_id, data FROM part ORDER BY time_created')
      .all() as Array<{ session_id?: unknown; data?: unknown }>
    const ids = new Set<string>()
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || typeof row.data !== 'string') continue
      try {
        const data = JSON.parse(row.data) as { type?: unknown; text?: unknown }
        if (data.type === 'text' && data.text === text) ids.add(row.session_id)
      } catch {
        // Ignore malformed historical parts; the exact prompt must still be found.
      }
    }
    return [...ids]
  } catch {
    return []
  } finally {
    db?.close()
  }
}

function selectedStore(sid: string): {
  layout: StoreReading['layout']
  path: string
  selectionReason: string
} {
  if (ARM === 'pre-fix') {
    return {
      layout: 'legacy-shared',
      path: LEGACY_DB,
      selectionReason: 'pre-fix control: OpenCode is expected to use its legacy cwd-keyed store',
    }
  }
  return {
    layout: 'session-owned',
    path: opencodeSessionDbPath(AGENT_HOME, sid),
    selectionReason: 'with-fix arm: launch must select the Podium-session-owned OpenCode store',
  }
}

async function waitForStore(session: Session, minimumMessages: number): Promise<StoreReading> {
  const nativeSessionId = session.nativeSessionId
  assertThat(nativeSessionId, `session ${session.sid} has no native OpenCode session id`)
  const selected = selectedStore(session.sid)
  const deadline = Date.now() + STORE_WAIT_MS
  let latest: StoreReading[] = []
  while (Date.now() < deadline) {
    latest = [readStore(selected.path, selected.layout, nativeSessionId, selected.selectionReason)]
    const match = latest.find(
      (reading) =>
        reading.counts !== undefined &&
        reading.counts.sessionRows > 0 &&
        reading.counts.messageRows >= minimumMessages,
    )
    if (match) return match
    await wait(250)
  }
  throw new Error(
    `NO MEASUREMENT: OpenCode store for Podium session ${session.sid} (native ${nativeSessionId}) never became readable with ${minimumMessages} message row(s); queried ${selected.path} because ${selected.selectionReason}: ${safeJson(latest)}`,
  )
}

async function waitForStoreByPartText(
  session: Session,
  text: string,
  minimumMessages: number,
): Promise<StoreReading> {
  const observedNativeSessionId = session.nativeSessionId ?? '(not read yet)'
  const selected = selectedStore(session.sid)
  const deadline = Date.now() + STORE_WAIT_MS
  let candidates: string[] = []
  let latest: StoreReading | undefined
  while (Date.now() < deadline) {
    candidates = storeSessionIdsForPartText(selected.path, text)
    if (candidates.length === 1) {
      const [querySessionId] = candidates
      if (querySessionId) {
        latest = readStore(
          selected.path,
          selected.layout,
          querySessionId,
          `${selected.selectionReason}; resolved by exact fault prompt part`,
        )
        if (
          latest.counts !== undefined &&
          latest.counts.sessionRows > 0 &&
          latest.counts.messageRows >= minimumMessages
        ) {
          return latest
        }
      }
    }
    await wait(250)
  }
  throw new Error(
    `NO MEASUREMENT: fault store row for Podium session ${session.sid} was not uniquely readable by its exact prompt; observed native=${observedNativeSessionId}, queried ${selected.path}, prompt=${JSON.stringify(text)}, candidates=${safeJson(candidates)}, latest=${safeJson(latest)}`
  )
}

async function requireExpectedDriver(
  sid: string,
  requestedCwd: string,
): Promise<{
  actualCwd: string
  driverId: string
  driverFamily: string
  requestedDriverId?: string
}> {
  const result = await until(sid, (row) => row?.driverId !== undefined, 30_000, 250)
  assertThat(result.ok, `session ${sid} never exposed a driver id`)
  const row = result.row
  assertThat(row, `session ${sid} disappeared before its driver identity could be read`)
  assertThat(row.cwd, `session ${sid} did not expose its actual cwd`)
  assertThat(
    row.cwd === requestedCwd,
    `session ${sid} was spawned for cwd ${requestedCwd} but the product reports cwd ${row.cwd}`,
  )
  assertThat(
    row.driverId === EXPECTED_DRIVER,
    `session ${sid} used driver ${row.driverId}, expected ${EXPECTED_DRIVER}`,
  )
  assertThat(
    row.driverFamily === EXPECTED_DRIVER_FAMILY,
    `session ${sid} used driver family ${row.driverFamily ?? '(none)'}, expected ${EXPECTED_DRIVER_FAMILY}`,
  )
  return {
    actualCwd: row.cwd,
    driverId: row.driverId,
    driverFamily: row.driverFamily,
    ...(row.requestedDriverId ? { requestedDriverId: row.requestedDriverId } : {}),
  }
}

async function requireNativeSessionId(session: Session): Promise<string> {
  const result = await until(
    session.sid,
    (row) => row?.resume?.kind === 'opencode-session' && typeof row.resume.value === 'string',
    30_000,
    250,
  )
  assertThat(
    result.ok && result.row?.resume?.value,
    `session ${session.sid} never exposed its native OpenCode session identity: ${safeJson(result.row)}`,
  )
  const nativeSessionId = result.row.resume.value
  session.nativeSessionId = nativeSessionId
  console.log(
    `  identity  sid=${session.sid} cwd=${session.actualCwd} driver=${session.driverId}/${session.driverFamily} native=${nativeSessionId} store=${selectedStore(session.sid).path}`,
  )
  return nativeSessionId
}

async function requireNativeSessionIdNow(session: Session): Promise<string> {
  const row = await sessionRow(session.sid)
  assertThat(
    row?.resume?.kind === 'opencode-session' && typeof row.resume.value === 'string',
    `session ${session.sid} did not expose its native OpenCode session identity before the fault stop: ${safeJson(row)}`,
  )
  const nativeSessionId = row.resume.value
  session.nativeSessionId = nativeSessionId
  console.log(
    `  identity  sid=${session.sid} cwd=${session.actualCwd} driver=${session.driverId}/${session.driverFamily} native=${nativeSessionId} store=${selectedStore(session.sid).path}`,
  )
  return nativeSessionId
}

async function waitForTerminalComposer(chat: Chat, sid: string): Promise<void> {
  const deadline = Date.now() + TERMINAL_READY_WAIT_MS
  let screen = ''
  while (Date.now() < deadline) {
    screen = chat.screenTail(2_000)
    if (screen.includes('Ask anything')) {
      console.log(`  ready     sid=${sid} product terminal readout contains Ask anything`)
      return
    }
    await wait(250)
  }
  throw new Error(
    `NO MEASUREMENT: terminal session ${sid} never showed the product composer readout; last screen=${JSON.stringify(screen)}`,
  )
}
async function createSession(input: {
  cwd: string
  prompt: string
  model?: string
}): Promise<Session> {
  const payload = {
    cwd: input.cwd,
    agentKind: AGENT_KIND[HARNESS] ?? HARNESS,
    ...(input.model ? { model: input.model } : {}),
  }
  const created = await mutate('sessions.create', payload)
  const sid = created.result?.data?.sessionId as string | undefined
  assertThat(sid, `sessions.create failed: ${safeJson(created)}`)

  const chat = new Chat(sid)
  await chat.open('native')
  sessions.push(sid)
  chats.push(chat)
  const identity = await requireExpectedDriver(sid, input.cwd)
  const ready = await until(
    sid,
    (row) => row?.status === 'live' && row.driverId !== undefined,
    60_000,
    250,
  )
  assertThat(ready.ok, `session ${sid} never reached live state before its prompt was sent`)
  await waitForTerminalComposer(chat, sid)
  const startupScreen = input.model ? chat.screenTail(8_000) : undefined
  const sent = await mutate('sessions.sendText', { sessionId: sid, text: input.prompt })
  assertThat(
    sent.result?.data?.ok === true && sent.error === undefined,
    `sessions.sendText was not accepted for ${sid}: ${safeJson(sent)}`,
  )
  console.log(
    `  identity  sid=${sid} requestedCwd=${input.cwd} actualCwd=${identity.actualCwd} driver=${identity.driverId}/${identity.driverFamily}${identity.requestedDriverId ? ` requested=${identity.requestedDriverId}` : ''}`,
  )
  return { sid, cwd: input.cwd, chat, ...identity, ...(startupScreen ? { startupScreen } : {}) }
}

async function createHealthy(
  cwd: string,
  tag: string,
): Promise<MeasuredSession & { nonce: string }> {
  const word = nonce(`POD2871-${tag}`)
  const session = await createSession({
    cwd,
    prompt: `Reply with exactly this word and nothing else: ${word}. Do not use any tools.`,
  })
  const answer = await untilText(session.chat, (text) => text.includes(word), ANSWER_WAIT_MS, {
    pumpFor: session.sid,
  })
  assertThat(
    answer.ok,
    `healthy ${tag} session ${session.sid} did not return its nonce ${word}; content=${JSON.stringify(session.chat.assistantText())}`,
  )
  console.log(
    `  control   ${tag} API transcript returned its own nonce before any store read: ${word}`,
  )
  const nativeSessionId = await requireNativeSessionId(session)
  const store = await waitForStore(session, 2)
  session.nativeSessionId = nativeSessionId
  session.store = store
  assertThat(
    (store.counts?.assistantRows ?? 0) > 0,
    `healthy ${tag} session has no assistant row: ${safeJson(store)}`,
  )
  return { ...session, nativeSessionId, store, nonce: word }
}

async function sameDirectoryCase(): Promise<CaseResult> {
  console.log('\nCASE same-directory: healthy companion plus unable-to-run fault')
  const companion = await createHealthy(REPO, 'COMPANION')
  console.log(`  companion sid=${companion.sid} nonce=${companion.nonce}`)

  // Keep the companion alive while the fault is created. This is the ordering
  // that let the old cwd-keyed read path select the neighbour's transcript.
  const faultPrompt = `Say hello. Probe marker ${nonce('POD2871-FAULT')}`
  const fault = await createSession({ cwd: REPO, model: FAULT_MODEL, prompt: faultPrompt })
  console.log(`  fault     sid=${fault.sid} model=${FAULT_MODEL}`)
  const expectedFaultReadout = `Model ${FAULT_MODEL} is not valid`
  const faultStartupScreen = fault.startupScreen ?? ''
  assertThat(
    faultStartupScreen.includes(expectedFaultReadout),
    `fault session did not show the product's unable-to-run readout before input was sent ${JSON.stringify(expectedFaultReadout)}: ${JSON.stringify(faultStartupScreen)}`,
  )

  const faultStore = await waitForStoreByPartText(fault, faultPrompt, 1)
  const faultNativeSessionId = await requireNativeSessionIdNow(fault)
  // Submitting the prompt dismisses OpenCode's startup model error and can let
  // the valid default answer race the row-count read. Once the exact user part
  // exists, stop the fault process immediately; the startup refusal is already
  // a product readout and the required user-only row is now durable.
  await mutate('sessions.kill', { sessionId: fault.sid }).catch(() => {})
  await wait(500)
  const faultOutcome = {
    ok: faultStartupScreen.includes(expectedFaultReadout),
    row: await sessionRow(fault.sid),
  }
  const companionStore = readStore(
    companion.store.path,
    companion.store.layout,
    companion.nativeSessionId,
    companion.store.selectionReason,
  )
  const companionText = companion.chat.assistantText().trim()
  const faultText = fault.chat.assistantText().trim()
  const faultScreen = fault.chat.screenTail(2_000)
  const failures: string[] = []

  console.log(
    `  identity  fault observedNative=${faultNativeSessionId} faultStore=${faultStore.querySessionId} companionNative=${companionStore.querySessionId}`,
  )
  check(
    failures,
    faultStore.querySessionId !== companionStore.querySessionId,
    `fault store row resolved to the companion native id: ${faultStore.querySessionId}`,
  )
  check(
    failures,
    EXPECTS_ISOLATION
      ? faultNativeSessionId === faultStore.querySessionId
      : faultNativeSessionId !== faultStore.querySessionId,
    EXPECTS_ISOLATION
      ? `with-fix product resume id ${faultNativeSessionId} did not match its own store row ${faultStore.querySessionId}`
      : `pre-fix product resume id ${faultNativeSessionId} unexpectedly matched its own store row ${faultStore.querySessionId}`,
  )

  // These are deliberate content assertions. A non-empty transcript alone is
  // not evidence: the old bug returned the companion's non-empty answer here.
  check(
    failures,
    companionText.includes(companion.nonce),
    `companion content lost its own nonce: ${JSON.stringify(companionText)}`,
  )
  if (EXPECTS_ISOLATION) {
    check(
      failures,
      faultText === '',
      `fault session returned assistant content: ${JSON.stringify(faultText)}`,
    )
    check(
      failures,
      !faultText.includes(companion.nonce),
      `fault session displayed the companion nonce: ${companion.nonce}`,
    )
  } else {
    check(
      failures,
      faultText.includes(companion.nonce),
      `pre-fix control did not reproduce the companion nonce in fault content: ${JSON.stringify(faultText)}`,
    )
    check(
      failures,
      faultStore.path === companionStore.path,
      `pre-fix control did not use the legacy shared store for both sessions: fault=${faultStore.path} companion=${companionStore.path}`,
    )
  }
  check(
    failures,
    faultStartupScreen.includes(expectedFaultReadout),
    `fault terminal startup readout did not contain ${JSON.stringify(expectedFaultReadout)} before input: ${JSON.stringify(faultStartupScreen)}`,
  )
  check(
    failures,
    faultOutcome.ok,
    `fault session startup refusal was not observed before input: ${JSON.stringify(faultStartupScreen)}`,
  )

  const counts = faultStore.counts
  check(failures, counts !== undefined, `fault store counts unavailable: ${safeJson(faultStore)}`)
  check(
    failures,
    counts?.messageRows === 1,
    `fault message row count was ${counts?.messageRows ?? '(unreadable)'}, expected 1: ${safeJson(faultStore)}`,
  )
  check(
    failures,
    counts?.userRows === 1,
    `fault user row count was ${counts?.userRows ?? '(unreadable)'}, expected 1: ${safeJson(faultStore)}`,
  )
  check(
    failures,
    counts?.assistantRows === 0,
    `fault assistant row count was ${counts?.assistantRows ?? '(unreadable)'}, expected 0: ${safeJson(faultStore)}`,
  )
  check(
    failures,
    (counts?.partRows ?? 0) >= 1,
    `fault part row count was ${counts?.partRows ?? '(unreadable)'}, expected at least 1: ${safeJson(faultStore)}`,
  )
  check(
    failures,
    (companionStore.counts?.userRows ?? 0) >= 1,
    `companion store has no user row: ${safeJson(companionStore)}`,
  )
  check(
    failures,
    (companionStore.counts?.assistantRows ?? 0) >= 1,
    `companion store has no assistant row: ${safeJson(companionStore)}`,
  )
  if (EXPECTS_ISOLATION) {
    check(
      failures,
      companionStore.path !== faultStore.path,
      `same-directory sessions still share an OpenCode store: ${companionStore.path}`,
    )
  }

  const result: CaseResult = {
    name: 'same-directory',
    sessions: [
      {
        sid: companion.sid,
        cwd: companion.cwd,
        actualCwd: companion.actualCwd,
        driverId: companion.driverId,
        driverFamily: companion.driverFamily,
        requestedDriverId: companion.requestedDriverId,
        nativeSessionId: companion.nativeSessionId,
        assistantText: companionText,
        screenTail: companion.chat.screenTail(2_000),
        store: companionStore,
      },
      {
        sid: fault.sid,
        cwd: fault.cwd,
        actualCwd: fault.actualCwd,
        driverId: fault.driverId,
        driverFamily: fault.driverFamily,
        requestedDriverId: fault.requestedDriverId,
        nativeSessionId: faultNativeSessionId,
        assistantText: faultText,
        screenTail: faultScreen,
        startupScreen: faultStartupScreen,
        store: faultStore,
      },
    ],
    failures,
    assertions: [
      'companion content contains its own nonce',
      EXPECTS_ISOLATION
        ? 'fault content is empty and does not contain the companion nonce'
        : 'pre-fix control fault content contains the companion nonce',
      `fault terminal readout contains ${expectedFaultReadout}`,
      'fault store has exactly one user message, zero assistant messages, and at least one part',
      EXPECTS_ISOLATION
        ? 'same-directory sessions use different stores'
        : 'pre-fix control sessions share the legacy store',
      `fault startup refusal was observed before input; post-stop row status=${faultOutcome.row?.status ?? '(gone)'}`,
    ],
  }
  console.log(
    `  ${failures.length === 0 ? 'PASS' : 'FAIL'}      fault content=${JSON.stringify(faultText)} readout=${JSON.stringify(expectedFaultReadout)} counts=${safeJson(counts)}`,
  )
  for (const failure of failures) console.log(`  ASSERTION ${failure}`)
  return result
}

async function differentDirectoryCase(): Promise<CaseResult> {
  console.log('\nCASE different-directory: two healthy sessions keep their own content')
  mkdirSync(LEFT_CWD, { recursive: true })
  mkdirSync(OTHER_CWD, { recursive: true })
  const left = await createHealthy(LEFT_CWD, 'LEFT')
  const right = await createHealthy(OTHER_CWD, 'RIGHT')
  const leftText = left.chat.assistantText().trim()
  const rightText = right.chat.assistantText().trim()
  const failures: string[] = []

  check(
    failures,
    leftText.includes(left.nonce),
    `left content lost its own nonce: ${JSON.stringify(leftText)}`,
  )
  check(
    failures,
    rightText.includes(right.nonce),
    `right content lost its own nonce: ${JSON.stringify(rightText)}`,
  )
  check(
    failures,
    !leftText.includes(right.nonce),
    `left session displayed right nonce: ${right.nonce}`,
  )
  check(
    failures,
    !rightText.includes(left.nonce),
    `right session displayed left nonce: ${left.nonce}`,
  )
  check(
    failures,
    (left.store.counts?.userRows ?? 0) >= 1,
    `left store has no user row: ${safeJson(left.store)}`,
  )
  check(
    failures,
    (left.store.counts?.assistantRows ?? 0) >= 1,
    `left store has no assistant row: ${safeJson(left.store)}`,
  )
  check(
    failures,
    (right.store.counts?.userRows ?? 0) >= 1,
    `right store has no user row: ${safeJson(right.store)}`,
  )
  check(
    failures,
    (right.store.counts?.assistantRows ?? 0) >= 1,
    `right store has no assistant row: ${safeJson(right.store)}`,
  )

  const result: CaseResult = {
    name: 'different-directory',
    sessions: [
      {
        sid: left.sid,
        cwd: left.cwd,
        actualCwd: left.actualCwd,
        driverId: left.driverId,
        driverFamily: left.driverFamily,
        requestedDriverId: left.requestedDriverId,
        nativeSessionId: left.nativeSessionId,
        assistantText: leftText,
        screenTail: left.chat.screenTail(2_000),
        store: left.store,
      },
      {
        sid: right.sid,
        cwd: right.cwd,
        actualCwd: right.actualCwd,
        driverId: right.driverId,
        driverFamily: right.driverFamily,
        requestedDriverId: right.requestedDriverId,
        nativeSessionId: right.nativeSessionId,
        assistantText: rightText,
        screenTail: right.chat.screenTail(2_000),
        store: right.store,
      },
    ],
    failures,
    assertions: [
      'each session content contains its own nonce',
      'neither session content contains the other nonce',
      'each store has user and assistant rows',
    ],
  }
  console.log(
    `  ${failures.length === 0 ? 'PASS' : 'FAIL'}      left=${JSON.stringify(leftText)} right=${JSON.stringify(rightText)}`,
  )
  for (const failure of failures) console.log(`  ASSERTION ${failure}`)
  return result
}

async function cleanup(): Promise<void> {
  const activeChats = chats.splice(0)
  const activeSessions = sessions.splice(0)
  for (const chat of activeChats) await chat.close().catch(() => {})
  for (const sid of activeSessions)
    await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
}

function writeEvidence(results: CaseResult[], extra: Record<string, unknown> = {}): void {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(
    join(OUT, 'result.json'),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), arm: ARM, base: BASE, harness: HARNESS, expectedDriver: EXPECTED_DRIVER, expectedDriverFamily: EXPECTED_DRIVER_FAMILY, expectedStoreLayout: EXPECTS_ISOLATION ? 'session-owned' : 'legacy-shared', faultModel: FAULT_MODEL, ...extra, results }, null, 2)}\n`,
  )
}

async function main(): Promise<void> {
  await login()
  const results: CaseResult[] = []
  try {
    const sameDirectory = await sameDirectoryCase()
    results.push(sameDirectory)
    if (ARM === 'pre-fix' && sameDirectory.failures.length > 0) {
      const failures = sameDirectory.failures.map((failure) => `same-directory: ${failure}`)
      writeEvidence(results, { verdict: 'FAIL', failures })
      console.error(
        `\nCONTROL FAIL — pre-fix leak was not reproduced; evidence written to ${join(OUT, 'result.json')}`,
      )
      process.exitCode = 1
      return
    }
    await cleanup()
    results.push(await differentDirectoryCase())
    const failures = results.flatMap((result) =>
      result.failures.map((failure) => `${result.name}: ${failure}`),
    )
    writeEvidence(results, {
      verdict: failures.length === 0 ? 'PASS' : 'FAIL',
      failures,
    })
    if (failures.length > 0) {
      console.error(
        `\nVERDICT FAIL — ${failures.length} assertion(s) failed; evidence written to ${join(OUT, 'result.json')}`,
      )
      process.exitCode = 1
    } else {
      console.log(
        `\nVERDICT PASS — ${ARM === 'pre-fix' ? 'pre-fix leak control reproduced and' : 'with-fix isolation held across'} both directory edges; evidence written to ${join(OUT, 'result.json')}`,
      )
    }
  } catch (error) {
    writeEvidence(results, { verdict: 'NO_MEASUREMENT', error: String(error) })
    console.error(`\nNO MEASUREMENT: ${String(error)}`)
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

await main()
