/**
 * POD-3050 — the A5 acceptance cell, driven for real on the p3050 rig.
 *
 *   bun docs/evidence/pod-3050/a5.ts <arm>
 *
 * A5 asks one question: after a headless Claude turn actually runs a tool, does
 * the durable transcript hold the CALL and its RESULT, paired, and does a reload
 * give back the same history? The cell logic below is POD-3036's `runA5`
 * unchanged — the same needles, the same predicates, the same verdict ladder —
 * so a green here is comparable to the BLOCKED it recorded before the fix.
 *
 * `<arm>` only names the reading file. WHICH CODE RAN is not taken from it: the
 * pin block reads the commit out of the server and daemon that are actually
 * serving, and refuses the cell if either is not the checked-out HEAD.
 *
 * No credential is copied, printed, refreshed or rotated. The isolated agent
 * home must NOT contain a credentials file, and the run refuses if it does.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { Chat, login, mutate, query, wait } from '../pod-2777/rig'

const arm = (process.argv[2] ?? 'fix').toLowerCase()
if (!/^[a-z0-9-]{1,32}$/.test(arm)) throw new Error('arm must be a short slug')

const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-3050'
const PORT = process.env.PODIUM_PORT ?? '19966'
const ROOT = process.cwd()
const READING_DIR = join(ROOT, 'docs/evidence/pod-3050/readings')
const PIN_DIR = join(ROOT, 'docs/evidence/pod-3050/pins')
const AGENT_HOME = join(
  process.env.P3050_STATE_ROOT ?? join(process.env.HOME ?? '', '.local/state/podium/p3050'),
  'agent-home',
)
const REPLY_MS = Number(process.env.P3050_REPLY_MS ?? 180_000)
const STEP_MS = 500

if (PORT === '19797') throw new Error('refusing to drive the operator instance')

const cwd = join(BASE, 'probes', 'claude-sdk-a5-' + arm)
const stamp = () => new Date().toISOString()
const short = (x: unknown, n = 260) => JSON.stringify(x).slice(0, n)
const textOf = (x: unknown) => (typeof x === 'string' ? x : String(x ?? ''))
const out = (command: string, args: string[]) =>
  (spawnSync(command, args, { encoding: 'utf8' }).stdout ?? '').trim()

interface Item {
  id?: string
  role?: string
  text?: string
  event?: string
  toolName?: string
  toolResult?: string
  toolUseId?: string
  [key: string]: unknown
}

function pidInfo(path: string): { pid: string; alive: boolean; cwd: string } {
  const pid = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
  let alive = false
  let processCwd = ''
  if (pid) {
    try {
      process.kill(Number(pid), 0)
      alive = true
    } catch {
      /* dead */
    }
    processCwd = out('readlink', [join('/proc', pid, 'cwd')])
  }
  return { pid, alive, cwd: processCwd }
}

function memInfo(): Record<string, string> {
  const rows: Record<string, string> = {}
  for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const m = line.match(/^(MemTotal|MemAvailable|SwapFree):\s+(\d+)\s+(\w+)/)
    if (m) rows[m[1] as string] = m[2] + ' ' + m[3]
  }
  return rows
}

/** Metadata ONLY — mtime and size. No credential file is ever read or copied. */
function credentialMeta(): Record<string, unknown> {
  const statOnly = (path: string) => {
    if (!existsSync(path)) return { present: false, path }
    const st = statSync(path)
    return { present: true, path, mtime: st.mtime.toISOString(), size: st.size }
  }
  return {
    live: statOnly(join(process.env.HOME ?? '', '.claude/.credentials.json')),
    isolated: statOnly(join(AGENT_HOME, '.claude/.credentials.json')),
  }
}

function daemonTos(): boolean {
  const pid = pidInfo(join(BASE, 'daemon.pid')).pid
  if (!pid) return false
  try {
    return readFileSync(join('/proc', pid, 'environ'), 'utf8')
      .split('\0')
      .includes('PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1')
  } catch {
    return false
  }
}

async function pinFor(label: string): Promise<Record<string, unknown>> {
  const checkoutSha = out('git', ['-C', ROOT, 'rev-parse', 'HEAD'])
  const dirty = spawnSync('git', [
    '-C',
    ROOT,
    'diff',
    '--quiet',
    'HEAD',
    '--',
    '.',
    ':!docs',
  ]).status
  const server = pidInfo(join(BASE, 'server.pid'))
  const daemon = pidInfo(join(BASE, 'daemon.pid'))
  const read = (name: string) =>
    existsSync(join(BASE, name)) ? readFileSync(join(BASE, name), 'utf8').trim() : ''
  const serverSha = read('server.sha')
  const daemonSha = read('daemon.sha')
  let web: Record<string, unknown> | { error: string }
  try {
    web = (await (await fetch('http://127.0.0.1:' + PORT + '/podium-build.json')).json()) as Record<
      string,
      unknown
    >
  } catch (error) {
    web = { error: String(error) }
  }
  const forbiddenOverrides: Record<string, string | null> = {}
  for (const key of ['PODIUM_STATE_DIR', 'PODIUM_AGENT_HOME', 'ABDUCO_SOCKET_DIR', 'TMUX_TMPDIR']) {
    forbiddenOverrides[key] = process.env[key] ?? null
  }
  const webSha = typeof web === 'object' && 'sourceSha' in web ? textOf(web.sourceSha) : ''
  const webReuseProof = {
    servedSourceSha: webSha,
    headShort: checkoutSha.slice(0, 7),
    appsWebIdentical:
      spawnSync('git', ['-C', ROOT, 'diff', '--quiet', webSha, 'HEAD', '--', 'apps/web']).status ===
      0,
  }
  const rootFreeKiB = Number(
    (out('df', ['-kP', '/']).split('\n')[1] ?? '').trim().split(/\s+/)[3] ?? 0,
  )
  const pin = {
    cell: 'A5',
    arm,
    at: stamp(),
    sourceRoot: ROOT,
    checkoutSha,
    productTreeClean: dirty === 0,
    serverSha,
    daemonSha,
    web,
    webReuseProof,
    serverPid: server.pid,
    daemonPid: daemon.pid,
    serverAlive: server.alive,
    daemonAlive: daemon.alive,
    serverCwd: server.cwd,
    daemonCwd: daemon.cwd,
    tosOnDaemon: daemonTos(),
    freeMemory: memInfo(),
    rootFreeKiB,
    load1m: loadavg()[0],
    credential: credentialMeta(),
    forbiddenOverrides,
  }
  mkdirSync(PIN_DIR, { recursive: true })
  writeFileSync(join(PIN_DIR, label + '.json'), JSON.stringify(pin, null, 2) + '\n')

  const isolatedCred = join(AGENT_HOME, '.claude/.credentials.json')
  if (existsSync(isolatedCred))
    throw new Error('isolated credential present; no-copy fence ' + isolatedCred)
  const overrides = Object.entries(forbiddenOverrides).filter(([, v]) => v !== null)
  // THE ARM NAME PROVES NOTHING; these do. Both long-lived processes must be
  // running the commit that is checked out, the tree must be clean against it,
  // and the SDK's terms must be acknowledged on the daemon that will spawn.
  if (
    !pin.productTreeClean ||
    serverSha !== checkoutSha ||
    daemonSha !== checkoutSha ||
    !server.alive ||
    !daemon.alive ||
    !(webReuseProof.appsWebIdentical || webSha === checkoutSha.slice(0, 7)) ||
    overrides.length > 0 ||
    rootFreeKiB < 5 * 1024 * 1024 ||
    !pin.tosOnDaemon
  ) {
    throw new Error('pin mismatch ' + short(pin, 900))
  }
  return pin
}

async function transcript(sid: string): Promise<Item[]> {
  const r = await query('sessions.read', { sessionId: sid, turns: 500 })
  return ((r.result?.data as { items?: Item[] } | undefined)?.items ?? []) as Item[]
}

function joined(items: Item[], role?: string): string {
  return items
    .filter((x) => !role || x.role === role)
    .map((x) => textOf(x.text))
    .join('\n')
}

async function waitForNeedle(
  sid: string,
  chat: Chat,
  needle: string,
  role: 'user' | 'assistant',
  timeout = REPLY_MS,
) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const items = await transcript(sid)
    const inChat = role === 'user' ? chat.userText() : chat.assistantText()
    if (joined(items, role).includes(needle) || inChat.includes(needle)) {
      return { ok: true, ms: Date.now() - started, items }
    }
    await wait(STEP_MS)
  }
  return { ok: false, ms: Date.now() - started, items: await transcript(sid) }
}

async function create(): Promise<{ sid: string; chat: Chat; row: unknown }> {
  mkdirSync(cwd, { recursive: true })
  if (!existsSync(join(cwd, '.git'))) {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd })
    writeFileSync(join(cwd, 'README.md'), 'POD-3050 claude-sdk A5 ' + arm + '\n')
    spawnSync('git', ['add', 'README.md'], { cwd })
    spawnSync(
      'git',
      ['-c', 'user.email=drive@localhost', '-c', 'user.name=drive', 'commit', '-qm', 'probe seed'],
      { cwd },
    )
  }
  const made = await mutate('sessions.create', {
    cwd,
    agentKind: 'claude-code',
    runtimeContract: 'claude-sdk',
  })
  const sid = (made.result?.data as { sessionId?: string } | undefined)?.sessionId
  if (!sid) throw new Error('sessions.create failed ' + short(made))
  const chat = new Chat(sid)
  await chat.open('chat')
  const started = Date.now()
  let row: Record<string, unknown> | undefined
  while (Date.now() - started < 30_000) {
    const r = await query('sessions.status', { ref: sid })
    row = r.result?.data as Record<string, unknown> | undefined
    if (row?.driverId || row?.driverFamily) break
    await wait(250)
  }
  if (row?.driverId !== 'claude-sdk') {
    throw new Error('session did not bind the claude-sdk driver: ' + short(row))
  }
  await wait(2_000)
  return { sid, chat, row }
}

/** POD-3036's A5, verbatim in its predicates. */
async function runA5(): Promise<Record<string, unknown>> {
  const { sid, chat, row } = await create()
  try {
    const marker = 'P3050-A5-MARKER-' + Date.now().toString(36).toUpperCase()
    writeFileSync(
      join(cwd, 'transcript-fixture.txt'),
      'transcript fixture test marker ' + marker + '\n',
    )
    const sent = await mutate('sessions.sendText', {
      sessionId: sid,
      text:
        'Use your Bash tool to run cat ' +
        join(cwd, 'transcript-fixture.txt') +
        ' and then reply with only the test marker it contains.',
    })
    const user = await waitForNeedle(sid, chat, 'transcript-fixture.txt', 'user', 5_000)
    const assistant = await waitForNeedle(sid, chat, marker, 'assistant', REPLY_MS)
    const before = await transcript(sid)
    await chat.close()
    const reload = new Chat(sid)
    await reload.open('chat')
    await wait(2_000)
    const after = await transcript(sid)

    const toolItems = before.filter(
      (x) => x.role === 'tool' || x.toolName || /tool/i.test(textOf(x.event)),
    )
    const resultItems = before.filter(
      (x) =>
        (x.role === 'tool' && !x.toolName) ||
        x.role === 'tool_result' ||
        /result/i.test(textOf(x.event)),
    )
    const paired =
      toolItems.length > 0 && (resultItems.length > 0 || before.some((x) => Boolean(x.toolName)))
    const project = (items: Item[]) =>
      JSON.stringify(
        items.map((x) => ({
          id: x.id,
          role: x.role,
          text: x.text,
          event: x.event,
          toolName: x.toolName,
        })),
      )
    const sameHistory = project(before) === project(after)
    // Beyond POD-3036's predicates: the pair must actually JOIN, which is what
    // makes the record replayable rather than merely present.
    const calls = before.filter((x) => x.role === 'tool' && x.toolName)
    const results = before.filter((x) => x.role === 'tool' && !x.toolName && x.toolUseId)
    const joinedPairs = calls.filter((c) => results.some((r) => r.toolUseId === c.toolUseId))
    const callBeforeResult = joinedPairs.every(
      (c) =>
        before.indexOf(c) <
        before.indexOf(results.find((r) => r.toolUseId === c.toolUseId) as Item),
    )
    const controlFired =
      user.ok || assistant.ok || Boolean((sent.result?.data as { ok?: boolean } | undefined)?.ok)

    await reload.close()
    const verdict = !controlFired
      ? 'BLOCKED'
      : !toolItems.length
        ? 'BLOCKED'
        : paired && sameHistory && assistant.ok && joinedPairs.length > 0 && callBeforeResult
          ? 'PASS'
          : 'FAIL'
    return {
      verdict,
      summary: !controlFired
        ? 'transcript control did not fire'
        : !toolItems.length
          ? 'agent did not produce a tool call, so pairing was not exercised'
          : verdict === 'PASS'
            ? 'tool call/result pair joined on toolUseId, call first, and reload history is intact'
            : 'tool transcript pairing or reload history failed',
      control: {
        fired: controlFired,
        what: 'the transcript fixture send delivering or a needle appearing',
        detail: 'user=' + user.ok + '; assistant=' + assistant.ok + '; items=' + before.length,
      },
      evidence: [
        'DRIVER            ' + short(row, 200),
        'SEND              ' + short(sent.result?.data ?? sent.error ?? null),
        'USER              ' + user.ok,
        'ASSISTANT         ' + assistant.ok,
        'TOOL ITEMS        ' + short(toolItems, 1400),
        'JOINED PAIRS      ' +
          joinedPairs.length +
          ' (call-before-result=' +
          callBeforeResult +
          ')',
        'RELOAD SAME       ' + sameHistory,
      ],
      data: {
        sid,
        marker,
        before,
        after,
        toolItems,
        resultItems,
        paired,
        sameHistory,
        joinedPairs: joinedPairs.length,
        callBeforeResult,
      },
    }
  } finally {
    await chat.close().catch(() => {})
    await mutate('sessions.kill', { sessionId: sid }).catch(() => {})
  }
}

await login()
const at = stamp()
const pin = await pinFor('claude-sdk-a5-' + arm)
let reading: Record<string, unknown>
try {
  reading = await runA5()
} catch (error) {
  reading = {
    verdict: 'REFUSED',
    summary: 'cell could not be driven: ' + String(error).slice(0, 240),
    control: {
      fired: false,
      what: 'the complete pinned cell running to a result',
      detail: String(error),
    },
    evidence: ['ERROR             ' + String(error)],
    data: {},
  }
}
mkdirSync(READING_DIR, { recursive: true })
const full = { cell: 'A5', driver: 'claude-sdk', arm, cwd, at, pin, ...reading }
writeFileSync(
  join(READING_DIR, 'claude-sdk.a5.' + arm + '.json'),
  JSON.stringify(full, null, 2) + '\n',
)
console.log('claude-sdk/A5[' + arm + '] ' + full.verdict + ' — ' + full.summary)
for (const line of (full.evidence as string[]) ?? []) console.log(line)
