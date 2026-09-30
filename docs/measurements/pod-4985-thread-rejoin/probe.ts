// Credential-free Codex 0.159.0 reconnect measurement. Run with the checkout's
// Bun: probe.ts <absolute codex binary> <output directory>. No installed HOME
// or credentials are passed to the app-server; inference stays on loopback.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const cli = resolve(process.argv[2]!)
const root = resolve(process.argv[3]!)
const home = `${root}/home`
const workdir = `${root}/work`
mkdirSync(`${home}/.codex`, { recursive: true })
mkdirSync(workdir, { recursive: true })
const log = (value: unknown) => appendFileSync(`${root}/frames.jsonl`, `${JSON.stringify({ at: Date.now(), ...value as object })}\n`)
const env = { HOME: home, CODEX_HOME: `${home}/.codex`, PATH: '/usr/bin:/bin', FAKE_KEY: 'dummy-not-a-key', LANG: 'C.UTF-8' }

async function port(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done))
  const value = (listener.address() as { port: number }).port
  await new Promise<void>((done) => listener.close(() => done()))
  return value
}

const fakePort = await port()
const rpcPort = await port()
writeFileSync(`${home}/.codex/config.toml`, `model = "fake"
model_provider = "fake"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:${fakePort}/v1"
env_key = "FAKE_KEY"
wire_api = "responses"
supports_websockets = false
[projects."${workdir}"]
trust_level = "trusted"
`)
const version = Bun.spawn([cli, '--version'], { env, stdout: 'pipe', stderr: 'pipe' })
log({ dir: 'mark', label: 'versions', codex: (await new Response(version.stdout).text()).trim(), bun: Bun.version, fakePort, rpcPort })
await version.exited
const fake = Bun.spawn([process.execPath, resolve(import.meta.dir, '../pod-4834-receipt-proof/codex-0.155.0/tools/fake-responses-server.ts')], {
  env: { PATH: '/usr/bin:/bin', FAKE_PORT: String(fakePort), FAKE_LOG: `${root}/model.jsonl` },
  stdout: Bun.file(`${root}/fake.stdout.log`), stderr: Bun.file(`${root}/fake.stderr.log`),
})
const engine = Bun.spawn([cli, 'app-server', '--listen', `ws://127.0.0.1:${rpcPort}`], {
  cwd: workdir, env,
  stdout: Bun.file(`${root}/engine.stdout.log`), stderr: Bun.file(`${root}/engine.stderr.log`),
})
const clients: Rpc[] = []

class Rpc {
  nextId = 0
  frames: any[] = []
  pending = new Map<number, (frame: any) => void>()
  constructor(readonly ws: WebSocket, readonly tag: string) {
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      this.frames.push(frame)
      log({ dir: 'in', tag, frame })
      const resolve = this.pending.get(frame.id)
      if (resolve && !frame.method) { this.pending.delete(frame.id); resolve(frame) }
    })
  }
  async call(method: string, params: unknown = {}) {
    const id = ++this.nextId
    const frame = { id, method, params }
    log({ dir: 'out', tag: this.tag, frame })
    const reply = new Promise<any>((done) => this.pending.set(id, done))
    this.ws.send(JSON.stringify(frame))
    const timeout = setTimeout(() => this.pending.get(id)?.({ error: { message: `timeout: ${method}` } }), 15000)
    try { return await reply } finally { clearTimeout(timeout); this.pending.delete(id) }
  }
  async wait(predicate: (frame: any) => boolean, timeout = 15000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const frame = this.frames.find(predicate)
      if (frame) return frame
      await Bun.sleep(20)
    }
    throw new Error(`notification timeout on ${this.tag}`)
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>((done) => this.ws.addEventListener('close', () => done(), { once: true }))
    this.ws.close()
    await closed
    log({ dir: 'mark', label: 'connection-closed', tag: this.tag })
  }
}

async function connect(tag: string): Promise<Rpc> {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const ws = new WebSocket(`ws://127.0.0.1:${rpcPort}`)
    const opened = await new Promise<boolean>((done) => {
      ws.addEventListener('open', () => done(true), { once: true })
      ws.addEventListener('error', () => done(false), { once: true })
    })
    if (!opened) { ws.close(); await Bun.sleep(50); continue }
    const rpc = new Rpc(ws, tag)
    clients.push(rpc)
    const initialized = await rpc.call('initialize', { clientInfo: { name: 'podium_rejoin_probe', title: 'Podium rejoin probe', version: '1' }, capabilities: { experimentalApi: true } })
    if (initialized.error) throw new Error(JSON.stringify(initialized.error))
    ws.send(JSON.stringify({ method: 'initialized' }))
    return rpc
  }
  throw new Error('app-server listener did not start')
}

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }]
async function start(rpc: Rpc, value: string) {
  const answer = await rpc.call('thread/start', { cwd: workdir, model: 'fake', approvalPolicy: 'never', sandbox: 'read-only' })
  if (answer.error) throw new Error(JSON.stringify(answer.error))
  const thread = answer.result.thread
  const turn = await rpc.call('turn/start', { threadId: thread.id, input: text(value) })
  if (turn.error) throw new Error(JSON.stringify(turn.error))
  return { thread, turnId: turn.result.turn.id }
}

const results: any[] = []
try {
  // Unloaded case: persist one turn, disconnect its only subscriber, and ask
  // the new connection to use that same surviving app-server.
  const a = await connect('unloaded-A')
  const unloaded = await start(a, 'quick persist before disconnect')
  await a.wait((f) => f.method === 'turn/completed' && f.params.turn.id === unloaded.turnId)
  await a.close()
  const b = await connect('unloaded-B')
  const grace = await b.call('thread/loaded/list')
  // 0.159.0 keeps an unsubscribed thread in memory for a grace period.
  // Stock archive/unarchive RPCs unload the scratch thread and restore the
  // same rollout path, avoiding a 30-minute wall-clock wait for idle eviction.
  const archived = await b.call('thread/archive', { threadId: unloaded.thread.id })
  const restored = await b.call('thread/unarchive', { threadId: unloaded.thread.id })
  const loaded = await b.call('thread/loaded/list')
  const before = await b.call('turn/start', { threadId: unloaded.thread.id, input: text('before rejoin') })
  const resumed = await b.call('thread/resume', { threadId: unloaded.thread.id, path: unloaded.thread.path })
  const after = await b.call('turn/start', { threadId: unloaded.thread.id, input: text('after rejoin') })
  if (after.result) await b.wait((f) => f.method === 'turn/completed' && f.params.turn.id === after.result.turn.id)
  results.push({ case: 'unloaded', threadId: unloaded.thread.id, path: unloaded.thread.path, grace, archived, restoredPath: restored.result?.thread?.path, restoreError: restored.error, loaded, before, resumedId: resumed.result?.thread?.id, resumeError: resumed.error, after, engineAlive: engine.exitCode === null })
  await b.close()

  // Running case: resume is safe on a turn still streaming from the fake
  // provider. Its completion must arrive on B with the original turn id.
  const runningA = await connect('running-A')
  const running = await start(runningA, 'SLOWTEXT running across disconnect')
  await runningA.wait((f) => f.method === 'item/agentMessage/delta')
  const runningB = await connect('running-B')
  const runningLoaded = await runningB.call('thread/loaded/list')
  const subscriptionBefore = await runningB.call('thread/unsubscribe', { threadId: running.thread.id })
  const rejoined = await runningB.call('thread/resume', { threadId: running.thread.id, path: running.thread.path })
  await runningA.close()
  const completed = await runningB.wait((f) => f.method === 'turn/completed' && f.params.turn.id === running.turnId)
  const next = await runningB.call('turn/start', { threadId: running.thread.id, input: text('usable after running rejoin') })
  if (next.result) await runningB.wait((f) => f.method === 'turn/completed' && f.params.turn.id === next.result.turn.id)
  results.push({ case: 'running', threadId: running.thread.id, turnId: running.turnId, loaded: runningLoaded, subscriptionBefore, resumedId: rejoined.result?.thread?.id, resumeError: rejoined.error, completed, next, engineAlive: engine.exitCode === null })
  writeFileSync(`${root}/results.json`, JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
} finally {
  await Promise.all(clients.map((rpc) => rpc.close()))
  engine.kill()
  await engine.exited
  // Kill only the fake model we own, identified by its dedicated listening port.
  const cleanup = Bun.spawn(['/usr/bin/fuser', '-k', `${fakePort}/tcp`], { stdout: 'ignore', stderr: 'pipe' })
  await cleanup.exited
  await fake.exited
}
