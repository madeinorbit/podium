// OpenCode 1.18.33 command provenance: live, reconnect, and process restart.
// Run from the repository root: bun docs/measurements/pod-4906-opencode-command-events/measure.ts
// Uses only a scratch HOME and a loopback fake model; never real credentials.
import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'

const out = resolve(process.argv[2] ?? import.meta.dir)
mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'pod-4906-command-events-'))
const homeDir = join(scratch, 'home')
const workDir = join(scratch, 'work')
const dbPath = join(homeDir, '.local/share/opencode/opencode.db')
const hookLog = join(scratch, 'hooks.jsonl')
const binary = process.env.OC_BIN ?? Bun.which('opencode')!
if (!binary) throw new Error('OpenCode is not installed')
const previousHarness = resolve(
  import.meta.dir,
  '../pod-4834-receipt-proof/opencode-1.18.33/harness',
)
const timeline = join(out, 'timeline.jsonl')
writeFileSync(timeline, '')
const records: any[] = []
function log(kind: string, fields: Record<string, unknown> = {}) {
  const record = JSON.parse(
    JSON.stringify({ at: Date.now(), kind, ...fields }).replaceAll(scratch, '$SCRATCH'),
  )
  records.push(record)
  appendFileSync(timeline, `${JSON.stringify(record)}\n`)
}
function save(name: string, value: unknown) {
  writeFileSync(
    join(out, name),
    `${JSON.stringify(value, null, 2).replaceAll(scratch, '$SCRATCH')}\n`,
  )
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(predicate: () => boolean, label: string, timeout = 60_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`)
    await pause(25)
  }
}
const env: Record<string, string> = {
  PATH: process.env.PATH!,
  LANG: 'C.UTF-8',
  TERM: 'xterm-256color',
  HOME: homeDir,
  XDG_CONFIG_HOME: join(homeDir, '.config'),
  XDG_CACHE_HOME: join(homeDir, '.cache'),
  XDG_DATA_HOME: join(homeDir, '.local/share'),
  XDG_STATE_HOME: join(homeDir, '.local/state'),
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  HOOK_LOG: hookLog,
}
for (const dir of [
  homeDir,
  workDir,
  ...['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].map((k) => env[k]!),
]) {
  mkdirSync(dir, { recursive: true })
}
mkdirSync(join(workDir, '.opencode/commands'), { recursive: true })
mkdirSync(join(workDir, '.opencode/plugins'), { recursive: true })
copyFileSync(
  join(previousHarness, 'probe-command.md'),
  join(workDir, '.opencode/commands/probe.md'),
)
copyFileSync(
  join(previousHarness, 'hooklog-plugin.ts'),
  join(workDir, '.opencode/plugins/capture.ts'),
)
writeFileSync(hookLog, '')

let requestCount = 0
let slowStarted = false
const model = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const body = req.method === 'POST' ? ((await req.json()) as any) : {}
    const index = ++requestCount
    const messages = (body.messages ?? []).map((m: any) => ({
      role: m.role,
      content:
        m.role === 'system' ? `[system: ${JSON.stringify(m.content).length} bytes]` : m.content,
    }))
    const slow = JSON.stringify(messages.filter((m: any) => m.role === 'user')).includes('SLOWTEXT')
    log('model.request', { index, path: new URL(req.url).pathname, slow, messages })
    if (!new URL(req.url).pathname.endsWith('/chat/completions')) return Response.json({ data: [] })
    slowStarted ||= slow && !!body.tools?.length
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(controller) {
          const chunk = (delta: unknown, finish: string | null = null) =>
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: `fake-${index}`,
                  object: 'chat.completion.chunk',
                  created: 0,
                  model: 'fake',
                  choices: [{ index: 0, delta, finish_reason: finish }],
                })}\n\n`,
              ),
            )
          try {
            chunk({ role: 'assistant', content: '' })
            for (let i = 0; i < (slow && body.tools?.length ? 100 : 3); i++) {
              await pause(slow && body.tools?.length ? 250 : 20)
              chunk({ content: `fake${index}.${i} ` })
            }
            chunk({}, 'stop')
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          } catch {
            /* The crash probe deliberately disconnects its model stream. */
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
const config = JSON.parse(readFileSync(join(previousHarness, 'opencode.json'), 'utf8'))
config.provider.fake.options.baseURL = `http://127.0.0.1:${model.port}/v1`
writeFileSync(join(workDir, 'opencode.json'), JSON.stringify(config, null, 2))

// Reserve an available port instead of touching any existing OpenCode/Podium runtime.
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
const port = reservation.port
reservation.stop(true)
const base = `http://127.0.0.1:${port}`
let server: ChildProcess | undefined
let generation = 0
let sid = ''
const streams: Array<{ abort: AbortController; task: Promise<void> }> = []
async function start() {
  generation++
  const child = spawn(binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: workDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server = child
  child.stdout!.on('data', (data) => log('server.stdout', { generation, text: String(data) }))
  child.stderr!.on('data', (data) => log('server.stderr', { generation, text: String(data) }))
  let ready = false
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited: ${child.exitCode}`)
    try {
      ready = (await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(1000) })).ok
      if (ready) break
    } catch {}
    await pause(250)
  }
  if (!ready) throw new Error('OpenCode readiness timed out')
  log('server.ready', { generation, pid: child.pid, port })
}
async function stop(signal: NodeJS.Signals) {
  const child = server
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((r) =>
    child.once('exit', (code, sig) => {
      log('server.exit', { generation, code, signal: sig })
      r()
    }),
  )
  child.kill(signal)
  await exited
  server = undefined
}
function url(path: string) {
  return `${base}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(workDir)}`
}
async function http(method: string, path: string, body?: unknown, label?: string) {
  log('http.send', { label, method, path, body })
  try {
    const response = await fetch(url(path), {
      method,
      signal: AbortSignal.timeout(60_000),
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let value: any = text
    try {
      value = JSON.parse(text)
    } catch {}
    log('http.reply', { label, method, path, status: response.status, body: value })
    return { status: response.status, body: value }
  } catch (error) {
    log('http.error', { label, method, path, error: String(error) })
    return { status: 0, body: undefined }
  }
}
async function open(path: string, label: string, headers: Record<string, string> = {}) {
  const abort = new AbortController()
  log('sse.subscribe', { label, path, headers })
  const task = (async () => {
    // The v2 session endpoint does not flush headers until it has an event.
    // Keep opening it independent of the command that creates that event.
    let response: Response
    try {
      response = await fetch(url(path), { signal: abort.signal, headers })
    } catch (error) {
      log('sse.end', { label, error: String(error) })
      return
    }
    log('sse.open', {
      label,
      path,
      headers,
      status: response.status,
      contentType: response.headers.get('content-type'),
    })
    if (!response.ok) {
      log('sse.error', { label, body: await response.text() })
      return
    }
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        pending += decoder.decode(result.value, { stream: true }).replaceAll('\r', '')
        for (;;) {
          const end = pending.indexOf('\n\n')
          if (end < 0) break
          const raw = pending.slice(0, end)
          pending = pending.slice(end + 2)
          const data = raw
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (!data) continue
          let frame: unknown = data
          try {
            frame = JSON.parse(data)
          } catch {}
          log('sse', {
            label,
            frame,
            id: raw
              .split('\n')
              .find((line) => line.startsWith('id:'))
              ?.slice(3)
              .trim(),
          })
        }
      }
    } catch (error) {
      log('sse.end', { label, error: String(error) })
    }
  })()
  streams.push({ abort, task })
}
async function closeStreams() {
  const current = streams.splice(0)
  for (const stream of current) stream.abort.abort()
  await Promise.all(current.map((stream) => stream.task))
}
function hooks() {
  return readFileSync(hookLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
function snapshot(label: string) {
  const db = new Database(dbPath, { readonly: true })
  try {
    const schema = db
      .query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as any[]
    const tables: Record<string, any[]> = {}
    for (const { name } of schema) {
      const quoted = `"${name.replaceAll('"', '""')}"`
      tables[name] = db
        .query(`SELECT * FROM ${quoted}`)
        .all()
        .map((row: any) => {
          const normalized = { ...row }
          if (typeof row.data === 'string') {
            try {
              normalized.data = JSON.parse(row.data)
            } catch {}
          }
          return normalized
        })
    }
    const result = { label, schema, tables }
    save(`${label}.json`, result)
    log('snapshot', {
      label,
      tables: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
      commandMarkers: Object.entries(tables).flatMap(([table, rows]) =>
        rows
          .filter((row) => JSON.stringify(row).includes('command.executed'))
          .map((row) => ({ table, row })),
      ),
    })
    return result
  } finally {
    db.close()
  }
}
const commands = (label: string) =>
  records.filter(
    (r) => r.kind === 'sse' && r.label === label && r.frame?.type === 'command.executed',
  )
async function reconnect(label: string) {
  await open('/event?after=0', `${label}.v1`, { 'Last-Event-ID': '0' })
  await open('/api/event', `${label}.v2-global`)
  await open(`/api/session/${sid}/event?after=0`, `${label}.v2-session`)
  await pause(2000)
}
const runCommand = (args: string, label: string) =>
  http('POST', `/session/${sid}/command`, { command: 'probe', arguments: args }, label)
function files() {
  const found: any[] = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', 'snapshot', '.git'].includes(entry.name)) walk(path)
      } else if (entry.isFile()) {
        const size = statSync(path).size
        const text =
          size < 5_000_000 && !/\.db(?:-|$)|\.zip$|\.gz$|\.wasm$/.test(path)
            ? readFileSync(path, 'utf8')
            : ''
        const matches = text.split('\n').filter((line) => /command\.executed/.test(line))
        found.push({ path: path.replace(scratch, '$SCRATCH'), size, commandExecutedLines: matches })
      }
    }
  }
  walk(homeDir)
  walk(workDir)
  return found
}

try {
  log('setup', {
    scratch,
    binary,
    fakePort: model.port,
    credentialSources: 'fresh HOME/XDG, only fake provider enabled; no inherited API keys',
  })
  const version = Bun.spawnSync([binary, '--version'], { env }).stdout.toString().trim()
  log('version', { version })
  if (version !== '1.18.33') throw new Error(`Expected 1.18.33, got ${version}`)
  await start()
  const doc = (await fetch(url('/doc')).then((r) => r.json())) as any
  save(
    'routes.json',
    Object.fromEntries(
      Object.entries(doc.paths ?? {}).filter(([path]) => /event|command/.test(path)),
    ),
  )
  await open('/event', 'live.v1')
  const created = await http(
    'POST',
    '/session',
    { title: 'Command provenance restart probe' },
    'create',
  )
  sid = created.body?.id
  if (!sid) throw new Error('Session creation did not return an id')
  await open('/api/event', 'live.v2-global')
  await open(`/api/session/${sid}/event?after=0`, 'live.v2-session')

  log('mark', { name: 'completed.begin', sid })
  const completed = await runCommand('completed', 'completed')
  if (completed.status !== 200) throw new Error(`Command failed: ${completed.status}`)
  await until(() => commands('live.v1').length === 1, 'completed command event')
  const completedSnapshot = snapshot('completed')
  await closeStreams()
  await reconnect('reconnect')
  snapshot('reconnect')
  await http('GET', `/session/${sid}/message`, undefined, 'reconnect.history-v1')
  await http(
    'GET',
    `/api/session/${sid}/message?order=asc&limit=200`,
    undefined,
    'reconnect.history-v2',
  )

  // Run a command with no external subscriber. A plugin remains an independent
  // positive control, but its added log is not OpenCode's native persistence.
  await closeStreams()
  log('mark', { name: 'missed.begin' })
  const missed = await runCommand('missed', 'missed')
  if (missed.status !== 200) throw new Error(`Missed-event command failed: ${missed.status}`)
  await reconnect('missed-reconnect')
  const beforeCrash = snapshot('missed-reconnect')

  // command.executed is tested for timing too: kill after the expansion and
  // assistant stream are durable, while the fake reply is still running.
  await closeStreams()
  await open('/event', 'crash-live.v1')
  log('mark', { name: 'crash.begin' })
  const pendingCommand = runCommand('SLOWTEXT crash-before-event', 'crash')
  await until(() => slowStarted, 'fake model started the command reply')
  await pause(750)
  const crashSnapshot = snapshot('crash-before-kill')
  const previousIds = new Set(beforeCrash.tables.message!.map((m) => m.id))
  const crashMessages = crashSnapshot.tables.message!.filter((m) => !previousIds.has(m.id))
  const crashUser = crashMessages.find((m) => m.data.role === 'user')
  const crashAssistant = crashMessages.find(
    (m) => m.data.role === 'assistant' && m.data.parentID === crashUser?.id,
  )
  if (!crashUser || !crashAssistant)
    throw new Error('Crash probe did not reach both native message rows')
  log('mark', { name: 'crash.kill', expansionId: crashUser.id, assistantId: crashAssistant.id })
  await stop('SIGKILL')
  await pendingCommand
  await closeStreams()
  snapshot('after-kill')
  await start()
  await reconnect('restart')
  const restartSnapshot = snapshot('restart')
  await http('GET', `/session/${sid}/message`, undefined, 'restart.history-v1')
  await http(
    'GET',
    `/api/session/${sid}/message?order=asc&limit=200`,
    undefined,
    'restart.history-v2',
  )
  const replayCommands = records.filter(
    (r) =>
      r.kind === 'sse' &&
      /^(reconnect|missed-reconnect|restart)\./.test(r.label) &&
      r.frame?.type === 'command.executed',
  )
  log('mark', { name: 'restart.replay-window.end' })

  // Confirm the restarted stream and plugin are functioning, not merely silent.
  const fresh = await runCommand('after-restart', 'fresh')
  if (fresh.status !== 200) throw new Error(`Fresh command failed: ${fresh.status}`)
  await until(() => commands('restart.v1').length === 1, 'fresh command after restart')
  const beforeControl = snapshot('fresh')
  const countBeforeControl = requestCount
  await http(
    'POST',
    `/session/${sid}/prompt_async`,
    { parts: [{ type: 'text', text: 'S9 CMD TEMPLATE expanded with: completed' }] },
    'ordinary.same-text',
  )
  await until(
    () => requestCount > countBeforeControl,
    'ordinary same-text prompt reaches fake model',
  )
  await pause(1500)
  const final = snapshot('final')
  const completedEvent = commands('live.v1')[0].frame
  const completedAssistant = completedSnapshot.tables.message!.find(
    (m) => m.id === completedEvent.properties.messageID,
  )
  const completedUser = completedSnapshot.tables.message!.find(
    (m) => m.id === completedAssistant?.data.parentID,
  )
  const controlIds = new Set(beforeControl.tables.message!.map((m) => m.id))
  const ordinary = final.tables.message!.find(
    (m) => !controlIds.has(m.id) && m.data.role === 'user',
  )
  const nativeFiles = files()
  save('native-files.json', nativeFiles)
  save('hooks.jsonl.json', hooks())
  const summary = {
    version,
    sid,
    completed: { event: completedEvent, assistant: completedAssistant, expansion: completedUser },
    missed: {
      responseAssistantId: missed.body?.info?.id,
      pluginEvents: hooks().filter(
        (h) =>
          h.hook === 'event' &&
          h.input?.type === 'command.executed' &&
          h.input?.properties?.arguments === 'missed',
      ),
    },
    crash: {
      expansion: crashUser,
      assistant: crashAssistant,
      liveCommandEvents: commands('crash-live.v1').length,
      pluginCommandEvents: hooks().filter(
        (h) =>
          h.hook === 'event' &&
          h.input?.type === 'command.executed' &&
          h.input?.properties?.arguments === 'SLOWTEXT crash-before-event',
      ).length,
      persistedExpansion: restartSnapshot.tables.message!.find((m) => m.id === crashUser.id),
    },
    replayCommands,
    nativeCommandRows: Object.entries(final.tables).flatMap(([table, rows]) =>
      rows
        .filter((row) => JSON.stringify(row).includes('command.executed'))
        .map((row) => ({ table, row })),
    ),
    nativeFileCommandMarkers: nativeFiles.filter((f) => f.commandExecutedLines.length),
    freshEvents: commands('restart.v1').map((r) => r.frame),
    ordinarySameText: ordinary,
  }
  save('summary.json', summary)
  log('result', {
    replayCommands: replayCommands.length,
    nativeCommandRows: summary.nativeCommandRows.length,
    nativeFileMarkers: summary.nativeFileCommandMarkers.length,
    crashCommandEvents: summary.crash.liveCommandEvents,
    freshEvents: summary.freshEvents.length,
    ordinaryControl: ordinary?.id,
  })
  process.stdout.write(`${JSON.stringify({ version, ...records.at(-1) }, null, 2)}\n`)
} finally {
  await closeStreams()
  await stop('SIGTERM')
  model.stop(true)
  if (existsSync(hookLog)) save('hooks.jsonl.json', hooks())
  rmSync(scratch, { recursive: true, force: true })
}
