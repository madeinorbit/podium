import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Chat, login, mutate, query, wait } from '../pod-2777/rig'

const ROOT = process.cwd()
const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2987-20260827T1743'
const INSTANCE = process.env.PODIUM_INSTANCE ?? 'p2987q-8271743'
const STATE = process.env.PODIUM_RIG_STATE_ROOT ?? `/home/mgw/.local/state/podium/${INSTANCE}`
const PTY_CWD = join(BASE, 'probes/claude-pty')
const HEADLESS_ROOT = join(STATE, 'headless-turns')
const READINGS = join(ROOT, 'docs/evidence/pod-2987/readings')
const MARKER_PTY = `P2987-PTY-${Date.now().toString(36).toUpperCase()}`
const MARKER_SDK = `P2987-SDK-${(Date.now() + 1).toString(36).toUpperCase()}`
const QUOTA = /(?:weekly|usage|rate) limit|monthly spend limit|spend limit|quota|hit your limit|used\s+\d+%|resets?\s+[A-Z][a-z]{2}|resets?\s+\d/i
const LOGGED_OUT = /not logged in|run\s+\/login|sign in|oauth|token expired|refresh required/i

type SafeProcess = {
  pid: number
  ppid: number | null
  exe: string
  cwd: string
  cmdline: string[]
  identityEnv: Record<string, string | null>
}

const iso = () => new Date().toISOString()
const exists = async (path: string) => Bun.file(path).exists()
const clean = (value: string) =>
  value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

function proc(pid: number): SafeProcess | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const environ = Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const at = entry.indexOf('=')
          return [entry.slice(0, at), entry.slice(at + 1)]
        }),
    )
    const keys = [
      'PODIUM_INSTANCE',
      'PODIUM_SESSION_ID',
      'PODIUM_SPAWN_SHA',
      'HOME',
      'CLAUDE_CONFIG_DIR',
      'ABDUCO_SOCKET_DIR',
    ]
    return {
      pid,
      ppid: Number(fields[1]) || null,
      exe: Bun.file(`/proc/${pid}/exe`).exists() ? readlink(`/proc/${pid}/exe`) : '',
      cwd: readlink(`/proc/${pid}/cwd`),
      cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .map((part, index, all) =>
          all[index - 1] === '--append-system-prompt'
            ? '<system-prompt-redacted; not evidence>'
            : part,
        ),
      identityEnv: Object.fromEntries(keys.map((key) => [key, environ[key] ?? null])),
    }
  } catch {
    return undefined
  }
}

function readlink(path: string): string {
  const out = Bun.spawnSync(['readlink', '-f', path])
  return out.exitCode === 0 ? out.stdout.toString().trim() : ''
}

function allProcesses(): SafeProcess[] {
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => proc(Number(entry)))
    .filter((entry): entry is SafeProcess => Boolean(entry))
}

function sessionProcesses(sessionId: string): SafeProcess[] {
  return allProcesses().filter(
    (entry) =>
      entry.identityEnv.PODIUM_INSTANCE === INSTANCE &&
      entry.identityEnv.PODIUM_SESSION_ID === sessionId,
  )
}

function pinnedProcess(name: 'server' | 'daemon'): SafeProcess {
  const pid = Number(readFileSync(join(BASE, `${name}.pid`), 'utf8').trim())
  const info = proc(pid)
  if (!info) throw new Error(`${name} pid ${pid} is not alive`)
  const expected = readFileSync(join(BASE, `${name}.sha`), 'utf8').trim()
  if (info.cwd !== ROOT || info.identityEnv.PODIUM_SPAWN_SHA !== expected) {
    throw new Error(`${name} pin mismatch`)
  }
  return info
}

async function status(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const body = await query('sessions.status', { ref: sessionId })
  return body.result?.data
}

async function transcript(sessionId: string): Promise<Record<string, unknown>[]> {
  const body = await query('sessions.read', { sessionId, turns: 100 })
  return body.result?.data?.items ?? []
}

function itemText(items: Record<string, unknown>[], role?: string): string {
  return items
    .filter((item) => !role || item.role === role)
    .map((item) => String(item.text ?? ''))
    .join('\n')
}

async function drivePty() {
  const startedAt = iso()
  const made = await mutate('sessions.create', { cwd: PTY_CWD, agentKind: 'claude-code' })
  const sessionId = made.result?.data?.sessionId as string | undefined
  if (!sessionId) throw new Error(`claude-pty create failed: ${JSON.stringify(made)}`)
  const chat = new Chat(sessionId)
  await chat.open()
  try {
    await wait(5_000)
    const sentAt = iso()
    const sent = await mutate('sessions.sendText', {
      sessionId,
      text: `Reply with exactly ${MARKER_PTY} and nothing else. Do not use tools.`,
    })
    const samples: Array<Record<string, unknown>> = []
    const deadline = Date.now() + 120_000
    let stableQuotaAt = 0
    while (Date.now() < deadline) {
      const items = await transcript(sessionId)
      const assistant = itemText(items, 'assistant')
      const screen = clean(chat.screen)
      const row = await status(sessionId)
      samples.push({ at: iso(), phase: row?.phase ?? null, screenBytes: chat.screenBytes })
      if (assistant.includes(MARKER_PTY)) break
      if (QUOTA.test(screen) && !LOGGED_OUT.test(screen)) {
        if (!stableQuotaAt) stableQuotaAt = Date.now()
        if (Date.now() - stableQuotaAt >= 4_000 && row?.phase !== 'working') break
      }
      await wait(500)
    }
    const items = await transcript(sessionId)
    const screen = clean(chat.screen)
    const row = await status(sessionId)
    const processes = sessionProcesses(sessionId)
    const assistant = itemText(items, 'assistant')
    const user = itemText(items, 'user')
    const quotaReported = QUOTA.test(screen) || QUOTA.test(assistant)
    const loggedOutReported = LOGGED_OUT.test(screen) || LOGGED_OUT.test(assistant)
    const markerReply = assistant.includes(MARKER_PTY)
    return {
      path: 'claude-pty',
      startedAt,
      sentAt,
      endedAt: iso(),
      marker: MARKER_PTY,
      sessionId,
      createAck: made.result?.data ?? null,
      sendAck: sent.result?.data ?? sent.error ?? null,
      positiveControl: {
        fired:
          processes.some((entry) => entry.cmdline.some((part) => /claude(?:$|\/)/.test(part))) &&
          chat.screenBytes > 0 &&
          user.includes(MARKER_PTY),
        driverIdPublished: row?.driverId ?? null,
        claudeProcessObserved: processes.some((entry) =>
          entry.cmdline.some((part) => /claude(?:$|\/)/.test(part)),
        ),
        terminalBytes: chat.screenBytes,
        promptPersisted: user.includes(MARKER_PTY),
      },
      classification: loggedOutReported
        ? 'logged-out-or-auth-refresh-required'
        : markerReply
          ? 'positive-turn-completed; weekly-quota-not-exhausted'
          : quotaReported
            ? 'provider-quota-or-limit-reported; turn-did-not-complete'
            : 'unclassified-no-reply',
      quotaReported,
      loggedOutReported,
      markerReply,
      status: row ?? null,
      processes,
      transcript: items,
      screen,
      samples,
    }
  } finally {
    await chat.close().catch(() => {})
    await mutate('sessions.kill', { sessionId }).catch(() => {})
  }
}

function durableDirs(): Set<string> {
  try {
    return new Set(readdirSync(HEADLESS_ROOT))
  } catch {
    return new Set()
  }
}

async function watchDurable(before: Set<string>) {
  const deadline = Date.now() + 120_000
  let dir = ''
  let processReading: SafeProcess | undefined
  while (Date.now() < deadline) {
    const fresh = [...durableDirs()].find((entry) => !before.has(entry))
    if (fresh) dir = join(HEADLESS_ROOT, fresh)
    if (dir) {
      if (!processReading && (await exists(join(dir, 'running')))) {
        const pid = Number((await Bun.file(join(dir, 'running')).text()).trim())
        processReading = proc(pid)
      }
      if (await exists(join(dir, 'result.json'))) break
    }
    await wait(20)
  }
  if (!dir) throw new Error('no new durable-headless journal appeared')
  const read = async (name: string) =>
    (await exists(join(dir, name))) ? await Bun.file(join(dir, name)).text() : ''
  return {
    dir,
    stat: {
      createdAt: (await exists(join(dir, 'created-at')))
        ? new Date(Number((await read('created-at')).trim())).toISOString()
        : null,
      resultMtime: (await exists(join(dir, 'result.json')))
        ? statSync(join(dir, 'result.json')).mtime.toISOString()
        : null,
    },
    process: processReading ?? null,
    exitCode: (await read('exit-code')).trim() || null,
    stdout: clean(await read('stdout.jsonl')),
    stderr: clean(await read('stderr.log')),
    result: (await read('result.json')).trim() || null,
    identity: (await read('request-identity.json')).trim() || null,
  }
}

async function driveSdk() {
  const startedAt = iso()
  const before = durableDirs()
  const watcher = watchDurable(before)
  const sent = await mutate('superagent.sendTurn', {
    threadId: 'global',
    text: `Reply with exactly ${MARKER_SDK} and nothing else. Do not use tools.`,
    agentKind: 'claude-code',
  })
  const ack = sent.result?.data
  if (!ack?.podiumSessionId) throw new Error(`claude-sdk send failed: ${JSON.stringify(sent)}`)
  const journal = await watcher
  const deadline = Date.now() + 30_000
  let thread: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    const threads = await query('superagent.listThreads', {})
    thread = (threads.result?.data ?? []).find((entry: Record<string, unknown>) => entry.id === 'global')
    if (thread && thread.turnRunning === false) break
    await wait(200)
  }
  const historyBody = await query('superagent.history', { threadId: 'global' })
  const history = (historyBody.result?.data ?? []) as Record<string, unknown>[]
  const historyText = history.map((entry) => String(entry.content ?? '')).join('\n')
  const combined = `${journal.stdout}\n${journal.stderr}\n${journal.result}\n${historyText}`
  const quotaReported = QUOTA.test(combined)
  const loggedOutReported = LOGGED_OUT.test(combined)
  const markerReply = historyText.includes(MARKER_SDK) || journal.stdout.includes(MARKER_SDK)
  const identity = journal.identity ? JSON.parse(journal.identity) : null
  return {
    path: 'claude-sdk via production durable-headless/headless-driver seam',
    startedAt,
    endedAt: iso(),
    marker: MARKER_SDK,
    sendAck: ack,
    positiveControl: {
      fired:
        identity?.sessionId === ack.podiumSessionId &&
        journal.exitCode !== null &&
        journal.stdout.includes("claude_code_version") &&
        Boolean(journal.stdout || journal.stderr) &&
        Boolean(journal.result),
      durableIdentityMatchesAck: identity?.sessionId === ack.podiumSessionId,
      runnerProcessObserved: Boolean(journal.process),
      claudeRuntimeEventObserved: journal.stdout.includes("claude_code_version"),
      exitCodePersisted: journal.exitCode,
      providerOutputPersisted: Boolean(journal.stdout || journal.stderr),
      resultPersisted: Boolean(journal.result),
    },
    classification: loggedOutReported
      ? 'logged-out-or-auth-refresh-required'
      : markerReply
        ? 'positive-turn-completed; weekly-quota-not-exhausted'
        : quotaReported
          ? 'provider-quota-or-limit-reported; turn-failed-honestly'
          : 'unclassified-turn-failure',
    quotaReported,
    loggedOutReported,
    markerReply,
    thread: thread ?? null,
    history,
    journal,
  }
}

await login()
const reading = {
  recordedAt: iso(),
  commit: readFileSync(join(BASE, 'daemon.sha'), 'utf8').trim(),
  commitTime: Bun.spawnSync(['git', 'show', '-s', '--format=%ci', 'HEAD']).stdout.toString().trim(),
  instance: INSTANCE,
  probeBase: BASE,
  stateRoot: STATE,
  agentHome: join(STATE, 'agent-home'),
  forbiddenPathOverrides: Object.fromEntries(
    ['HOME', 'PODIUM_STATE_DIR', 'PODIUM_AGENT_HOME', 'ABDUCO_SOCKET_DIR'].map((key) => [
      key,
      key === 'HOME' ? process.env[key] ?? null : process.env[key] ?? null,
    ]),
  ),
  credential: {
    sourceMtime: statSync('/home/mgw/.claude/.credentials.json').mtime.toISOString(),
    isolatedMtime: statSync(join(STATE, 'agent-home/.claude/.credentials.json')).mtime.toISOString(),
    expiresAt: JSON.parse(await Bun.file('/home/mgw/.claude/.credentials.json').text())?.claudeAiOauth
      ?.expiresAt,
    accessValidAtStart: true,
  },
  processPins: { server: pinnedProcess('server'), daemon: pinnedProcess('daemon') },
  claudePty: await drivePty(),
  claudeSdk: await driveSdk(),
}

await Bun.$`mkdir -p ${READINGS}`
const out = join(READINGS, `quota-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(out, JSON.stringify(reading, null, 2) + '\n')
console.log(out)
console.log(JSON.stringify({
  claudePty: {
    control: reading.claudePty.positiveControl,
    classification: reading.claudePty.classification,
  },
  claudeSdk: {
    control: reading.claudeSdk.positiveControl,
    classification: reading.claudeSdk.classification,
  },
}, null, 2))
