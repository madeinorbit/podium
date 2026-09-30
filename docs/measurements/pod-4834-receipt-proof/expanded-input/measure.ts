// Real-CLI measurements only; not a production test or driver. Scratch HOME,
// local fake, independent tmux server, and native history records without trimming.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { cases, bytes, sha } from './matrix.ts'

const [lane, selected] = process.argv.slice(2)
const lanes = ['codex-app-server', 'opencode-v1', 'opencode-v2', 'opencode2-v2', 'grok-acp', 'codex-terminal', 'opencode-terminal', 'opencode2-terminal', 'grok-terminal']
lanes.push(...['codex', 'opencode', 'opencode2', 'grok'].map(p => `${p}-terminal-paced`))
lanes.push('codex-terminal-raw')
if (!lanes.includes(lane!)) throw new Error(`Lane must be one of ${lanes}`)
const out = resolve(import.meta.dir, lane!)
mkdirSync(out, { recursive: true })
const root = mkdtempSync(`/tmp/podium-4984-${lane}-`)
const home = join(root, 'home'), work = join(root, 'work')
for (const dir of [home, work, `${home}/.codex`, `${home}/.grok`, `${home}/.config`, `${home}/.cache`, `${home}/.local/share`, `${home}/.local/state`]) mkdirSync(dir, { recursive: true })
const fakePort = Number(process.env.MEASURE_FAKE_PORT ?? 49984)
const appPort = Number(process.env.MEASURE_APP_PORT ?? 49985)
for (const port of [fakePort, appPort]) {
  try {
    const owner = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (owner) throw new Error(`Measurement port ${port} already owned by ${owner}; refusing to overwrite evidence`)
  } catch (e) { if (e instanceof Error && e.message.includes('refusing to overwrite')) throw e }
}
const bin = lane!.startsWith('codex') ? process.env.CODEX_MEASURE_BIN ?? 'codex'
  : lane!.startsWith('opencode2') ? 'opencode2' : lane!.startsWith('opencode') ? 'opencode' : 'grok'
// Deliberate allowlist: no inherited credential, agent session, or provider vars.
const env: Record<string, string> = {
  PATH: process.env.PATH!, HOME: home, CODEX_HOME: `${home}/.codex`, GROK_HOME: `${home}/.grok`,
  XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`,
  TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8', FAKE_KEY: 'dummy-not-a-key',
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_SERVER_PASSWORD: 'dummy-local-password',
}
writeFileSync(`${home}/.codex/config.toml`, `model = "fake"\nmodel_provider = "fake"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\ncheck_for_update_on_startup = false\n[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${fakePort}/v1"\nenv_key = "FAKE_KEY"\nwire_api = "responses"\n[projects."${work}"]\ntrust_level = "trusted"\n`)
writeFileSync(`${home}/.grok/config.toml`, `[models]\ndefault = "fake"\n[model.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${fakePort}/v1"\nenv_key = "FAKE_KEY"\n`)
const ocConfig = { provider: { fake: { npm: '@ai-sdk/openai-compatible', name: 'fake',
  options: { baseURL: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'dummy-not-a-key' },
  models: { fake: { name: 'fake', tool_call: true, limit: { context: 1000000, output: 1000 } } } } },
  model: 'fake/fake', small_model: 'fake/fake', enabled_providers: ['fake'], autoupdate: false, share: 'disabled', permission: 'allow' }
writeFileSync(`${work}/opencode.json`, JSON.stringify(ocConfig, null, 2))
env.OPENCODE_CONFIG = `${work}/opencode.json`
execFileSync('git', ['init', '-q', work], { env })
const version = execFileSync(bin, ['--version'], { env, encoding: 'utf8' }).trim()
const commandPath = execFileSync('which', [bin], { encoding: 'utf8' }).trim()
const run = { lane, version, commandPath, startedAt: new Date().toISOString(), root, fakePort, appPort,
  env, config: lane!.startsWith('opencode') ? ocConfig : readFileSync(`${home}/${lane!.startsWith('codex') ? '.codex' : '.grok'}/config.toml`, 'utf8'),
  tty: '180x45, independent tmux server; new terminal process for every case',
  methods: ['paste: tmux paste-buffer -r -p, exact input bytes including LF and CR',
    'typed: tmux send-keys -l, unbracketed literal bytes in 256-character chunks, 40ms between writes; 650ms pause then Enter',
    'typed-paced: unbracketed literal bytes in 256-character chunks, 40ms between writes; 650ms pause then Enter',
    'typed-buffer: tmux paste-buffer -r WITHOUT -p: unbracketed literal byte stream, no escape wrappers; programs can detect a fast burst as paste'],
  editorDrain: 'Unbracketed input waits for its final marker in the fresh editor before Enter (up to max(60s, 5ms per byte)); pending input is not a storage result.',
}
writeFileSync(`${out}/run.json`, JSON.stringify(run, null, 2) + '\n')
writeFileSync(`${import.meta.dir}/input-cases.jsonl`, cases.map(c => JSON.stringify({ ...c, bodyBytes: bytes(c.body), textBytes: bytes(c.text), sha256: sha(c.text) })).join('\n') + '\n')
const rec = (file: string, value: unknown) => appendFileSync(`${out}/${file}`, JSON.stringify(value) + '\n')
for (const file of ['observations.jsonl', 'native-records.jsonl', 'protocol.jsonl', 'model-requests.jsonl', 'stderr.txt', 'screens.txt']) writeFileSync(`${out}/${file}`, '')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(100) }
  return false
}
function logChild(child: ChildProcess, tag: string) {
  child.stdout?.on('data', d => appendFileSync(`${out}/stderr.txt`, `[${tag}:stdout] ${d}`))
  child.stderr?.on('data', d => appendFileSync(`${out}/stderr.txt`, `[${tag}:stderr] ${d}`))
}
const listening = (port: number) => {
  try { return execFileSync('lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean).map(Number) } catch { return [] }
}
if (listening(fakePort).length || listening(appPort).length) throw new Error('Measurement port already owned; refusing to take over')
const fake = spawn(process.execPath, [`${import.meta.dir}/fake-model-server.ts`], {
  env: { ...env, FAKE_PORT: String(fakePort), FAKE_LOG: `${out}/model-requests.jsonl` }, stdio: ['ignore', 'pipe', 'pipe'],
})
logChild(fake, 'fake')
if (!await until(() => existsSync(`${out}/model-requests.jsonl`) && readFileSync(`${out}/model-requests.jsonl`, 'utf8').includes('listening'), 10000)) throw new Error('Fake did not listen')
function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  try { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []) } catch { return [] }
}
type Native = { source: string, position: string | number, kind: string, raw: any, texts: string[], id?: string }
const contentText = (value: any): string[] => typeof value === 'string' ? [value] : Array.isArray(value)
  ? value.flatMap(v => typeof v?.text === 'string' ? [v.text] : []) : typeof value?.text === 'string' ? [value.text] : []
function history(): Native[] {
  const rows: Native[] = []
  if (lane!.startsWith('opencode')) {
    const path = `${home}/.local/share/opencode/opencode.db`
    if (!existsSync(path)) return rows
    const db = new Database(path, { readonly: true })
    try {
      for (const table of ['message', 'part', 'session_message', 'session_input', 'session_inbox']) {
        let entries: any[]
        try { entries = db.query(`select rowid as _rowid, * from ${table} order by rowid`).all() } catch { continue }
        for (const row of entries) {
          const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
          if (table === 'part' && data?.type === 'text' && db.query('select data from message where id = ?').get(row.message_id)) {
            const parent = db.query('select data from message where id = ?').get(row.message_id) as any
            if (JSON.parse(parent.data).role !== 'user') continue
            rows.push({ source: table, position: row._rowid, kind: 'prompt', raw: row, texts: [data.text], id: row.message_id })
          } else if (table === 'part' && data?.type === 'file') rows.push({ source: table, position: row._rowid, kind: 'attachment', raw: row, texts: [], id: row.message_id })
          else if (table === 'session_message' && (row.type === 'user' || data?.role === 'user' || data?.type === 'user')) {
            const text = data?.text ?? data?.prompt?.text ?? data?.content ?? data?.parts
            rows.push({ source: table, position: row._rowid, kind: 'prompt', raw: row, texts: contentText(text), id: row.id })
          } else if (table === 'session_input' || table === 'session_inbox') rows.push({ source: table, position: row._rowid, kind: 'admission', raw: row, texts: [], id: row.id })
        }
      }
    } finally { db.close() }
    for (const file of files(`${home}/.local/state/opencode`).filter(f => f.endsWith('/prompt-history.jsonl'))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      for (let n = 0; n < lines.length; n++) {
        if (!lines[n]) continue
        const raw = JSON.parse(lines[n]!)
        const texts = [raw.input ?? raw.text ?? '', ...(raw.parts ?? raw.pasted ?? []).flatMap((p: any) => contentText(p.text))]
        rows.push({ source: file.slice(home.length + 1), position: n + 1, kind: 'input-history', raw, texts })
      }
    }
    return rows
  }
  const dir = lane!.startsWith('codex') ? `${home}/.codex/sessions` : `${home}/.grok/sessions`
  const sources = files(dir)
  if (lane!.startsWith('codex') && existsSync(`${home}/.codex/history.jsonl`)) sources.push(`${home}/.codex/history.jsonl`)
  for (const file of sources) {
    if (file.includes('/prompts/') && file.endsWith('.txt')) {
      const text = readFileSync(file, 'utf8')
      rows.push({ source: file.slice(home.length + 1), position: 0, kind: 'spill-file', raw: { text, bytes: bytes(text), sha256: sha(text) }, texts: [text] })
      continue
    }
    if (!file.endsWith('.jsonl')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let n = 0; n < lines.length; n++) {
      if (!lines[n]) continue
      let raw: any; try { raw = JSON.parse(lines[n]!) } catch { continue }
      const source = file.slice(home.length + 1)
      const item = raw.payload?.item
      const update = raw.params?.update
      if (item?.type === 'UserMessage') rows.push({ source, position: n + 1, kind: 'prompt', raw, texts: contentText(item.content), id: item.client_id })
      else if (update?.sessionUpdate === 'user_message_chunk') rows.push({ source, position: n + 1, kind: 'prompt', raw, texts: contentText(update.content), id: raw.params?._meta?.eventId })
      else if (file.endsWith('/chat_history.jsonl') && (raw.type === 'user' || raw.type === 'human')) rows.push({ source, position: n + 1, kind: 'model-history', raw, texts: contentText(raw.content), id: raw.prompt_index?.toString() })
      else if (update?.sessionUpdate === 'turn_completed') rows.push({ source, position: n + 1, kind: 'turn-identity', raw, texts: [], id: update.prompt_id ?? raw.params?._meta?.promptId })
      else if (file.endsWith('/history.jsonl')) rows.push({ source, position: n + 1, kind: 'input-history', raw, texts: [raw.text ?? ''] })
      else if (file.endsWith('/prompt_history.jsonl')) rows.push({ source, position: n + 1, kind: 'input-history', raw, texts: [raw.prompt ?? ''] })
    }
  }
  return rows
}
function modelRows(): any[] {
  return readFileSync(`${out}/model-requests.jsonl`, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.method === 'POST')
}
function snapshot(label: string, before: Native[], after: Native[]) {
  const old = new Map(before.map(r => [`${r.source}:${r.position}`, JSON.stringify(r.raw)]))
  const changed = after.filter(r => old.get(`${r.source}:${r.position}`) !== JSON.stringify(r.raw))
  for (const r of changed) rec('native-records.jsonl', { label, ...r })
  return changed
}
let program: ChildProcess | undefined
const tmuxSocket = `pod4984-${process.pid}`
const tmux = (...args: string[]) => execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 })
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
async function stopTerminal() {
  const owned: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid || pid === fake.pid) continue
    try {
      if (readFileSync(`/proc/${pid}/environ`).toString().split('\0').includes(`HOME=${home}`)) owned.push(pid)
    } catch {}
  }
  for (const pid of owned) { try { process.kill(pid, 'SIGTERM') } catch {} }
  await sleep(400)
  for (const pid of owned) {
    try {
      // Fence pid reuse with this run's unique HOME again.
      if (readFileSync(`/proc/${pid}/environ`).toString().split('\0').includes(`HOME=${home}`)) process.kill(pid, 'SIGKILL')
    } catch {}
  }
  try { tmux('kill-session', '-t', 'measure') } catch {}
}
function rpc(command: string[]) {
  program = spawn(bin, command, { env, cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
  const child = program
  child.stderr!.on('data', d => appendFileSync(`${out}/stderr.txt`, d))
  let next = 1, buffer = ''
  const waiting = new Map<number, (value: any) => void>()
  const inbound: any[] = []
  child.stdout!.on('data', d => {
    buffer += d.toString()
    for (let pos = buffer.indexOf('\n'); pos >= 0; pos = buffer.indexOf('\n')) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1)
      let frame: any; try { frame = JSON.parse(line) } catch { continue }
      inbound.push(frame); rec('protocol.jsonl', { at: Date.now(), dir: 'in', frame })
      if (frame.id !== undefined && !frame.method) { waiting.get(frame.id)?.(frame); waiting.delete(frame.id) }
    }
  })
  const send = (frame: any) => { rec('protocol.jsonl', { at: Date.now(), dir: 'out', frame }); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n') }
  const call = (method: string, params: any) => {
    const id = next++
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`RPC timeout ${method}`)) }, 45000)
      waiting.set(id, value => { clearTimeout(timer); resolve(value) }); send({ id, method, params })
    })
  }
  return { call, send, inbound }
}
const auth = { authorization: 'Basic ' + Buffer.from('opencode:dummy-local-password').toString('base64') }
async function http(method: string, path: string, body?: any) {
  if (!path.startsWith('/api/')) path += (path.includes('?') ? '&' : '?') + `directory=${encodeURIComponent(work)}`
  rec('protocol.jsonl', { at: Date.now(), dir: 'out', method, path, body })
  const r = await fetch(`http://127.0.0.1:${appPort}${path}`, { method, headers: { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) })
  const raw = await r.text(); let data: any; try { data = JSON.parse(raw) } catch { data = raw }
  rec('protocol.jsonl', { at: Date.now(), dir: 'in', status: r.status, body: data })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw.slice(0, 400)}`)
  return data
}
try {
  const terminal = lane!.includes('terminal')
  let client: ReturnType<typeof rpc> | undefined
  async function launchTerminal(label: string) {
    const args = lane!.startsWith('grok') ? ['-m', 'fake', '--always-approve', '--trust']
      : lane!.startsWith('opencode2') ? ['--standalone', '--auto']
      : lane!.startsWith('opencode') ? ['--port', String(appPort), '--hostname', '127.0.0.1', '--model', 'fake/fake'] : []
    const command = `cd ${quote(work)} && exec env -i ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' ')} ${quote(commandPath)} ${args.map(quote).join(' ')}`
    tmux('new-session', '-d', '-s', 'measure', '-x', '180', '-y', '45', 'sleep 600')
    tmux('set-option', '-t', 'measure', 'remain-on-exit', 'on')
    tmux('respawn-pane', '-k', '-t', 'measure', command)
    // Wait for the input editor; a screen capture is diagnostic evidence only.
    const ready = await until(() => {
      const screen = tmux('capture-pane', '-p', '-t', 'measure')
      if (tmux('display-message', '-p', '-t', 'measure', '#{pane_dead}').trim() === '1') {
        appendFileSync(`${out}/screens.txt`, `PROCESS EXIT ${label}\n${screen}\n`)
        throw new Error(`Terminal exited: ${screen.trim().slice(0, 600)}`)
      }
      if (lane!.startsWith('codex')) return /context left|fake|OpenAI Codex/.test(screen)
      if (lane!.startsWith('grok')) return /fake|Type a message|Grok/.test(screen)
      return /Ask anything|Build|fake/.test(screen)
    }, 45000)
    if (!ready) {
      const screen = tmux('capture-pane', '-p', '-t', 'measure')
      appendFileSync(`${out}/screens.txt`, `EDITOR NOT READY ${label}\n${screen}\n`)
      throw new Error(`Terminal editor did not become ready: ${screen.trim().slice(0, 600)}`)
    }
    await sleep(2000)
    appendFileSync(`${out}/screens.txt`, `START ${label}\n${tmux('capture-pane', '-p', '-t', 'measure')}\n`)
  }
  if (!terminal && lane!.startsWith('codex')) {
    client = rpc(['app-server'])
    await client.call('initialize', { clientInfo: { name: 'podium-measurement', version: '0' }, capabilities: { experimentalApi: true } })
    client.send({ method: 'initialized' })
  } else if (!terminal && lane === 'grok-acp') {
    client = rpc(['agent', 'stdio'])
    await client.call('initialize', { protocolVersion: 1, clientInfo: { name: 'podium-measurement', version: '0' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
  } else if (!terminal) {
    program = spawn(bin, ['serve', '--port', String(appPort), '--hostname', '127.0.0.1'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
    logChild(program, 'program')
    if (!await until(async () => { try { return (await fetch(`http://127.0.0.1:${appPort}/api/health`, { headers: auth, signal: AbortSignal.timeout(2000) })).ok } catch { return false } }, 45000)) throw new Error('OpenCode server not ready')
  }
  for (const method of terminal ? lane!.endsWith('-raw') ? ['typed-buffer'] : lane!.endsWith('-paced') ? ['typed-paced'] : ['paste', 'typed'] : ['protocol']) {
    for (const c of cases.filter(c => !selected || c.name.includes(selected))) {
      const label = `${method}/${c.name}`
      if (terminal) await launchTerminal(label)
      const before = history(), modelBefore = modelRows().length
      const sentAt = Date.now()
      let extraEnterAt: number | undefined, editorDrainedAt: number | undefined, editorDrainComplete: boolean | undefined
      let sessionId: string | undefined, protocolId: string | undefined, status: any, error: string | undefined
      try {
        if (terminal) {
          if (method === 'paste' || method === 'typed-buffer') {
            writeFileSync(`${root}/paste.txt`, c.text)
            tmux('load-buffer', '-b', 'input', `${root}/paste.txt`)
            tmux('paste-buffer', '-r', ...(method === 'paste' ? ['-p'] : []), '-b', 'input', '-t', 'measure')
          } else if (method === 'typed-paced' || method === 'typed') {
            for (let i = 0; i < c.text.length; i += 256) {
              tmux('send-keys', '-t', 'measure', '-l', '--', c.text.slice(i, i + 256))
              await sleep(40)
            }
          } else tmux('send-keys', '-t', 'measure', '-l', '--', c.text)
          if (method !== 'paste') {
            const tail = c.framed ? `[end podium message ${c.id}]` : c.body.trimEnd().split(/\s+/).at(-1)!
            editorDrainComplete = await until(() => tmux('capture-pane', '-p', '-t', 'measure').replace(/\n/g, '').includes(tail), Math.max(60000, bytes(c.text) * 5))
            editorDrainedAt = Date.now()
            console.log(`${lane} ${label}: editor tail ${editorDrainComplete ? 'reached' : 'not reached'} after ${editorDrainedAt - sentAt}ms`)
          }
          await sleep(650)
          tmux('send-keys', '-t', 'measure', 'Enter')
          status = await until(() => history().filter(r => r.kind === 'prompt').length > before.filter(r => r.kind === 'prompt').length, 10000)
          if (!status) {
            appendFileSync(`${out}/screens.txt`, `NO RECORD AFTER FIRST ENTER ${label}\n${tmux('capture-pane', '-p', '-t', 'measure')}\n`)
            extraEnterAt = Date.now()
            tmux('send-keys', '-t', 'measure', 'Enter')
            status = await until(() => history().filter(r => r.kind === 'prompt').length > before.filter(r => r.kind === 'prompt').length, 10000)
          }
          // Wait for records/model calls to settle; detect splitting, never just take the first record.
          let last = '', stable = 0
          await until(() => {
            const sig = history().filter(r => r.kind === 'prompt').map(r => `${r.source}:${r.position}:${sha(r.texts.join(''))}`).join('|') + ':' + modelRows().length
            if (sig === last) stable += 1; else { stable = 0; last = sig }
            return stable >= 20
          }, 30000)
          appendFileSync(`${out}/screens.txt`, `${label}\n${tmux('capture-pane', '-p', '-t', 'measure')}\n`)
        } else if (lane!.startsWith('codex')) {
          const start = await client!.call('thread/start', { cwd: work })
          sessionId = start.result.thread.id; protocolId = c.id
          const reply = await client!.call('turn/start', { threadId: sessionId, clientUserMessageId: c.id, input: [{ type: 'text', text: c.text, text_elements: [] }] })
          if (reply.error) throw new Error(JSON.stringify(reply.error))
          status = await until(() => client!.inbound.some(f => f.method === 'turn/completed' && f.params?.turn?.id === reply.result.turn.id), 45000)
        } else if (lane === 'grok-acp') {
          const start = await client!.call('session/new', { cwd: work, mcpServers: [] })
          sessionId = start.result.sessionId; protocolId = c.id
          status = await client!.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: c.text }], _meta: { promptId: c.id } })
        } else if (lane === 'opencode-v1') {
          sessionId = (await http('POST', '/session', { title: label })).id; protocolId = c.id
          await http('POST', `/session/${sessionId}/prompt_async`, { messageID: c.id, parts: [{ id: `prt_000000000000${c.id.slice(4)}`, type: 'text', text: c.text }] })
          status = await until(async () => {
            const rows = await http('GET', `/session/${sessionId}/message`)
            return rows.some((r: any) => r.info?.role === 'assistant' && r.info?.time?.completed)
          }, 45000)
        } else {
          sessionId = (await http('POST', '/api/session', { title: label, location: { directory: work } })).data.id; protocolId = c.id
          await http('POST', `/api/session/${sessionId}/prompt`, lane === 'opencode2-v2' ? { id: c.id, text: c.text, delivery: 'queue' } : { id: c.id, prompt: { text: c.text }, delivery: 'queue' })
          status = await until(async () => {
            const active = await http('GET', '/api/session/active')
            return !JSON.stringify(active).includes(sessionId!) && modelRows().length > modelBefore
          }, 45000)
          await http('GET', `/api/session/${sessionId}/message?order=asc&limit=200`)
        }
      } catch (e) {
        const stderr = (e as { stderr?: string | Buffer }).stderr
        error = stderr ? String(stderr).trim().slice(0, 600) : String(e).slice(0, 600)
      }
      await sleep(300)
      const records = snapshot(label, before, history())
      const prompts = records.filter(r => r.kind === 'prompt')
      const models = modelRows().slice(modelBefore)
      const summary = { label, sentAt, extraEnterAt, editorDrainComplete, editorDrainedAt, finishedAt: Date.now(), sessionId, protocolId, status, error,
        case: c.name, inputBytes: bytes(c.text), inputSha256: sha(c.text),
        records: prompts.map(r => ({ source: r.source, position: r.position, id: r.id, texts: r.texts.map(t => ({ bytes: bytes(t), sha256: sha(t), exact: t === c.text, first: t.slice(0, 100), last: t.slice(-100) })) })),
        modelRequests: models.map(r => r.n), modelReceivedBody: models.some(r => JSON.stringify(r.messages).includes(c.body.slice(0, 24))) }
      rec('observations.jsonl', summary)
      console.log(`${lane} ${label}: ${prompts.length} prompt record(s), ${prompts.map(r => r.texts.map(bytes).join('+')).join(',')} bytes${error ? ' ERROR ' + error : ''}`)
      if (terminal) { await stopTerminal(); await sleep(200) }
    }
  }
} finally {
  if (lane!.includes('terminal')) await stopTerminal()
  if (program) { program.kill('SIGTERM'); await sleep(400); if (program.exitCode === null) program.kill('SIGKILL') }
  try { tmux('kill-server') } catch {}
  // Kill the fake by its port, with a pid fence so we never kill someone else's server.
  const pids = listening(fakePort)
  if (pids.length === 1 && pids[0] === fake.pid) process.kill(pids[0]!, 'SIGTERM')
  else if (pids.length) throw new Error('Fake port ownership changed; refusing cleanup')
  await sleep(200)
  writeFileSync(`${out}/run.json`, JSON.stringify({ ...run, finishedAt: new Date().toISOString() }, null, 2) + '\n')
}
