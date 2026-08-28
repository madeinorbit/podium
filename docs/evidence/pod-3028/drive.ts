import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Chat, login, mutate, query, wait } from '../pod-2777/rig'

const ROOT = process.cwd()
const BASE = process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-3028-20260828T0953'
const INSTANCE = process.env.PODIUM_INSTANCE ?? 'p3028q-8280953'
const STATE = process.env.PODIUM_RIG_STATE_ROOT ?? `/home/mgw/.local/state/podium/${INSTANCE}`
const PTY_CWD = join(BASE, 'probes/claude-pty')
const SDK_CWD = join(BASE, 'probes/claude-sdk')
const READINGS = join(ROOT, 'docs/evidence/pod-3028/readings')
const LIVE_CREDENTIAL = '/home/mgw/.claude/.credentials.json'
const MARKER_PTY = `P3028-PTY-${Date.now().toString(36).toUpperCase()}`
const MARKER_SDK = `P3028-SDK-${(Date.now() + 1).toString(36).toUpperCase()}`
const QUOTA =
  /(?:weekly|usage|rate) limit|monthly spend limit|spend limit|quota|hit your limit|used\s+\d+%|resets?\s+[A-Z][a-z]{2}|resets?\s+\d/i
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
const clean = (value: string) =>
  value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

function readlink(path: string): string {
  const out = Bun.spawnSync(['readlink', '-f', path])
  return out.exitCode === 0 ? out.stdout.toString().trim() : ''
}

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
      'PODIUM_CLAUDE_SDK_TOS_ACCEPTED',
      'PODIUM_RUNTIME_DRIVER',
      'HOME',
      'CLAUDE_CONFIG_DIR',
      'ABDUCO_SOCKET_DIR',
      'PODIUM_STATE_DIR',
      'PODIUM_AGENT_HOME',
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
      (entry.identityEnv.PODIUM_SESSION_ID === sessionId ||
        entry.cmdline.some((part) => part.includes(sessionId))),
  )
}

function instanceProcesses(): SafeProcess[] {
  return allProcesses().filter((entry) => entry.identityEnv.PODIUM_INSTANCE === INSTANCE)
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

function redactedCredential() {
  const st = statSync(LIVE_CREDENTIAL)
  const data = JSON.parse(readFileSync(LIVE_CREDENTIAL, 'utf8')) as {
    claudeAiOauth?: { expiresAt?: number; subscriptionType?: string }
  }
  const expiresAt = data.claudeAiOauth?.expiresAt
  return {
    path: LIVE_CREDENTIAL,
    mtime: st.mtime.toISOString(),
    sizeBytes: st.size,
    subscriptionType: data.claudeAiOauth?.subscriptionType ?? null,
    expiresAtIso: typeof expiresAt === 'number' ? new Date(expiresAt).toISOString() : null,
    expired: typeof expiresAt === 'number' ? expiresAt <= Date.now() : null,
  }
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

function classify(input: {
  loggedOut: boolean
  quota: boolean
  markerReply: boolean
}): string {
  if (input.loggedOut) return 'logged-out-or-auth-refresh-required'
  if (input.markerReply) return 'positive-turn-completed; quota-not-exhausted-on-this-path'
  if (input.quota) return 'provider-quota-or-limit-reported; turn-did-not-complete'
  return 'unclassified-no-reply'
}

function isClaudeBin(entry: SafeProcess): boolean {
  return entry.cmdline.some((part) => /(^|\/)claude$/.test(part))
}

function isSdkHost(entry: SafeProcess): boolean {
  return entry.cmdline.some((part) => part.includes('claude-sdk-host.ts'))
}

async function drivePty() {
  const startedAt = iso()
  const made = await mutate('sessions.create', { cwd: PTY_CWD, agentKind: 'claude-code' })
  const sessionId = made.result?.data?.sessionId as string | undefined
  if (!sessionId) throw new Error(`claude-pty create failed: ${JSON.stringify(made)}`)
  const chat = new Chat(sessionId)
  await chat.open('native')
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
      samples.push({ at: iso(), phase: row?.phase ?? null, driverId: row?.driverId ?? null, screenBytes: chat.screenBytes })
      if (assistant.includes(MARKER_PTY)) break
      if ((QUOTA.test(screen) || QUOTA.test(assistant)) && !LOGGED_OUT.test(screen)) {
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
    const combined = `${screen}\n${assistant}`
    const quotaReported = QUOTA.test(combined)
    const loggedOutReported = LOGGED_OUT.test(combined)
    const markerReply = assistant.includes(MARKER_PTY)
    return {
      path: 'interactive claude-pty (confirming control; default spawn, no runtimeContract)',
      startedAt,
      sentAt,
      endedAt: iso(),
      marker: MARKER_PTY,
      sessionId,
      createAck: made.result?.data ?? null,
      sendAck: sent.result?.data ?? sent.error ?? null,
      positiveControl: {
        fired:
          processes.some(isClaudeBin) &&
          chat.screenBytes > 0 &&
          user.includes(MARKER_PTY),
        driverIdPublished: row?.driverId ?? null,
        claudeProcessObserved: processes.some(isClaudeBin),
        sdkHostObserved: processes.some(isSdkHost) || instanceProcesses().some(isSdkHost),
        terminalBytes: chat.screenBytes,
        promptPersisted: user.includes(MARKER_PTY),
      },
      classification: classify({
        loggedOut: loggedOutReported,
        quota: quotaReported,
        markerReply,
      }),
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
  }
}

async function drivePersistentSdk() {
  const startedAt = iso()
  const made = await mutate('sessions.create', {
    cwd: SDK_CWD,
    agentKind: 'claude-code',
    runtimeContract: 'claude-sdk',
  })
  const sessionId = made.result?.data?.sessionId as string | undefined
  if (!sessionId) throw new Error(`claude-sdk create failed: ${JSON.stringify(made)}`)
  const chat = new Chat(sessionId)
  await chat.open('chat')
  try {
    await wait(2_000)
    const sentAt = iso()
    const sent = await mutate('sessions.sendText', {
      sessionId,
      text: `Reply with exactly ${MARKER_SDK} and nothing else. Do not use tools.`,
    })
    const samples: Array<Record<string, unknown>> = []
    const deadline = Date.now() + 120_000
    let stableQuotaAt = 0
    while (Date.now() < deadline) {
      const items = await transcript(sessionId)
      const assistant = itemText(items, 'assistant')
      const row = await status(sessionId)
      const hosts = instanceProcesses().filter(isSdkHost)
      samples.push({
        at: iso(),
        phase: row?.phase ?? null,
        driverId: row?.driverId ?? null,
        sdkHostPids: hosts.map((entry) => entry.pid),
      })
      if (assistant.includes(MARKER_SDK)) break
      if (QUOTA.test(assistant) && !LOGGED_OUT.test(assistant)) {
        if (!stableQuotaAt) stableQuotaAt = Date.now()
        if (Date.now() - stableQuotaAt >= 4_000 && row?.phase !== 'working') break
      }
      const phase = String(row?.phase ?? '')
      if (phase === 'errored' || phase === 'idle') {
        if (assistant || Date.now() - Date.parse(sentAt) > 15_000) break
      }
      await wait(500)
    }
    const items = await transcript(sessionId)
    const row = await status(sessionId)
    const processes = [...sessionProcesses(sessionId), ...instanceProcesses().filter(isSdkHost)]
    const assistant = itemText(items, 'assistant')
    const user = itemText(items, 'user')
    const quotaReported = QUOTA.test(assistant)
    const loggedOutReported = LOGGED_OUT.test(assistant)
    const markerReply = assistant.includes(MARKER_SDK)
    const daemon = pinnedProcess('daemon')
    return {
      path: 'persistent packages/agent-runtime Claude SDK RuntimeDriver via sessions.create runtimeContract=claude-sdk',
      startedAt,
      sentAt,
      endedAt: iso(),
      marker: MARKER_SDK,
      sessionId,
      createAck: made.result?.data ?? null,
      sendAck: sent.result?.data ?? sent.error ?? null,
      positiveControl: {
        fired:
          row?.driverId === 'claude-sdk' &&
          daemon.identityEnv.PODIUM_CLAUDE_SDK_TOS_ACCEPTED === '1' &&
          processes.some(isSdkHost) &&
          user.includes(MARKER_SDK),
        driverIdPublished: row?.driverId ?? null,
        tosAcceptedOnDaemon: daemon.identityEnv.PODIUM_CLAUDE_SDK_TOS_ACCEPTED,
        machineRuntimeDriver: daemon.identityEnv.PODIUM_RUNTIME_DRIVER,
        sdkHostObserved: processes.some(isSdkHost),
        durableHeadlessNotUsed: !existsSync(join(STATE, 'headless-turns')),
        promptPersisted: user.includes(MARKER_SDK),
      },
      classification: classify({
        loggedOut: loggedOutReported,
        quota: quotaReported,
        markerReply,
      }),
      quotaReported,
      loggedOutReported,
      markerReply,
      status: row ?? null,
      processes,
      transcript: items,
      samples,
    }
  } finally {
    await chat.close().catch(() => {})
  }
}

await login()
const credentialBefore = redactedCredential()
const daemon = pinnedProcess('daemon')
const server = pinnedProcess('server')
if (daemon.identityEnv.PODIUM_CLAUDE_SDK_TOS_ACCEPTED !== '1') {
  throw new Error('daemon is not running with PODIUM_CLAUDE_SDK_TOS_ACCEPTED=1')
}
if (daemon.identityEnv.PODIUM_RUNTIME_DRIVER) {
  throw new Error('daemon has PODIUM_RUNTIME_DRIVER set; refusing so the default Claude path stays PTY')
}

const reading = {
  recordedAt: iso(),
  commit: readFileSync(join(BASE, 'daemon.sha'), 'utf8').trim(),
  commitTime: Bun.spawnSync(['git', 'show', '-s', '--format=%ci', 'HEAD']).stdout.toString().trim(),
  instance: INSTANCE,
  probeBase: BASE,
  stateRoot: STATE,
  forbiddenPathOverrides: Object.fromEntries(
    ['HOME', 'PODIUM_STATE_DIR', 'PODIUM_AGENT_HOME', 'ABDUCO_SOCKET_DIR'].map((key) => [
      key,
      process.env[key] ?? null,
    ]),
  ),
  credentialBefore,
  isolatedCredentialExists: existsSync(join(STATE, 'agent-home/.claude/.credentials.json')),
  processPins: { server, daemon },
  claudePty: await drivePty(),
  claudeSdk: await drivePersistentSdk(),
  credentialAfter: redactedCredential(),
}

await Bun.$`mkdir -p ${READINGS}`
const out = join(READINGS, `quota-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(out, JSON.stringify(reading, null, 2) + '\n')
console.log(out)
console.log(
  JSON.stringify(
    {
      claudePty: {
        control: reading.claudePty.positiveControl,
        classification: reading.claudePty.classification,
      },
      claudeSdk: {
        control: reading.claudeSdk.positiveControl,
        classification: reading.claudeSdk.classification,
      },
      credentialMtimeUnchanged: reading.credentialBefore.mtime === reading.credentialAfter.mtime,
    },
    null,
    2,
  ),
)
