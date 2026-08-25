/**
 * POD-2761 — what a person sees when they switch a session Chat -> CLI -> Chat -> CLI.
 *
 *   bash docs/evidence/pod-2761/drive-up.sh
 *   bash docs/evidence/pod-2761/drive-verify.sh HEAD
 *   bun  docs/evidence/pod-2761/drive.ts [codex|opencode]
 *
 * THREE THINGS ARE MEASURED, and they are deliberately different in kind.
 *
 * 1. PROCESS TOPOLOGY — is the client terminal the SAME process across a view
 *    switch, or a new one? This is the coordinator's proposed mechanism, and it
 *    is settled by pids, not by reading the source.
 *
 * 2. THE BYTES — captured from the client websocket, the same stream the browser
 *    terminal consumes.
 *
 * 3. THE SCREEN — those bytes replayed through @xterm/headless (the headless
 *    build of the very emulator the browser runs) and the resulting buffer read
 *    back, SCROLLBACK INCLUDED. "The whole interface appears twice" is a claim
 *    about the buffer, so the buffer is what gets counted. A screenshot would
 *    show less: only the viewport.
 *
 * The drive is written to be run against a build WITH and WITHOUT the fix; it
 * reports counts and a verdict rather than asserting, so a red run is readable.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { Terminal } = require_('@xterm/headless') as {
  Terminal: new (o: Record<string, unknown>) => {
    write(data: string, cb: () => void): void
    buffer: { active: { length: number; getLine(i: number): { translateToString(t: boolean): string } | undefined } }
  }
}

const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
const PORT = process.env.PODIUM_PORT ?? '19827'
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'p2761'
const REPO = `${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2761'}/repo`
const harness = (process.argv[2] ?? 'codex') as 'codex' | 'opencode'
const LABEL = harness === 'codex' ? 'cx' : 'oc'

if (PORT === '19797') throw new Error('refusing to drive the operator instance')

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

const trpc = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { result?: { data?: unknown }; error?: unknown }
}

// --- a session with SEVERAL exchanges, which is the operator's setup ---------
console.log(`creating a ${harness} session with three exchanges…`)
const created = (await trpc('sessions.create', {
  cwd: REPO,
  agentKind: harness,
  initialPrompt: 'Say the word ALPHA and nothing else.',
})) as { result?: { data?: { sessionId?: string } } }
const sid = created.result?.data?.sessionId
if (!sid) throw new Error(`sessions.create failed: ${JSON.stringify(created)}`)
await wait(12_000)
for (const word of ['BRAVO', 'CHARLIE']) {
  await trpc('sessions.sendText', { sessionId: sid, text: `Say the word ${word} and nothing else.` })
  await wait(10_000)
}

// --- 1. process topology ----------------------------------------------------
const clientProcs = (): string[] => {
  const ps = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout ?? ''
  return ps
    .split('\n')
    .filter((l) => l.includes(`podium-${LABEL}-attach-${sid}`) && !l.includes('ps -eo'))
    .map((l) => l.trim().split(/\s+/)[0] as string)
}

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/client`, { headers: { cookie } } as never)
await new Promise((res, rej) => {
  ws.onopen = res as () => void
  ws.onerror = rej as () => void
})
const send = (o: unknown) => ws.send(JSON.stringify(o))
const view = (mode: 'native' | 'chat') =>
  send({ type: 'viewState', visible: [sid], focused: sid, modes: { [sid]: mode } })

let stream = ''
ws.onmessage = (e: MessageEvent) => {
  const m = JSON.parse(String(e.data)) as { type: string; sessionId?: string; data?: string }
  if (m.type === 'outputFrame' && m.sessionId === sid && m.data)
    stream += Buffer.from(m.data, 'base64').toString('binary')
}

const generations: string[][] = []
send({ type: 'attach', sessionId: sid })
for (const round of [1, 2]) {
  view('native')
  await wait(12_000)
  generations.push(clientProcs())
  console.log(`  round ${round}: CLI  -> client pids [${generations.at(-1)?.join(', ') || 'none'}]`)
  if (round === 1) {
    view('chat')
    await wait(6_000)
    console.log(`  round ${round}: Chat -> client pids [${clientProcs().join(', ') || 'none'}]`)
    // A REMOUNTED VIEW, which is what the browser does: leaving CLI unmounts the
    // terminal component, so it comes back with no screen and asks for a full
    // replay rather than a delta. That replay is where a duplicate lives.
    send({ type: 'detach', sessionId: sid })
    await wait(500)
    send({ type: 'attach', sessionId: sid })
  }
}

const [first = [], second = []] = generations
const sameProcess = first.length > 0 && first.join() === second.join()
console.log(`\n1. PROCESS: the CLI client is ${sameProcess ? 'THE SAME process' : 'a NEW process'} the second time`)

/**
 * THE CONTROL, AND IT IS NOT A FORMALITY — the first run of this rig reported
 * "VERDICT: the interface appears 0 time(s) — PASS" against a session that never
 * started a client terminal at all. Codex was logged out in the isolated agent
 * home, the driver quietly degraded to generic-pty, and zero duplicates is what
 * an empty stream always looks like.
 *
 * So the absence of a duplicate is only evidence when there was something that
 * COULD duplicate. Both legs are required: a client terminal process actually
 * existed, and its interface actually reached the stream. Anything less exits
 * non-zero and reports nothing a reader could mistake for a pass.
 */
const drewSomething = /* the harness banner reached the byte stream */ stream.length > 2_000
if (first.length === 0 || !drewSomething) {
  console.error(
    `\nNO MEASUREMENT: the path under test never ran — ` +
      `client pids seen: ${first.length}, bytes captured: ${stream.length}. ` +
      `Check the driver actually resolved (a logged-out harness degrades to generic-pty ` +
      `and starts no client terminal): grep 'preferred runtime driver' ${process.env.PODIUM_DRIVE_BASE ?? '/tmp/pod-2761'}/logs/daemon.log`,
  )
  await trpc('sessions.kill', { sessionId: sid })
  ws.close()
  process.exit(1)
}

// --- 3. the screen ----------------------------------------------------------
const term = new Terminal({ cols: 120, rows: 40, scrollback: 10_000, allowProposedApi: true })
await new Promise<void>((r) => term.write(stream, r))
const buf = term.buffer.active
const lines: string[] = []
for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
const screen = lines.join('\n')
const count = (re: RegExp) => (screen.match(re) ?? []).length

const banner = harness === 'codex' ? /OpenAI Codex/g : /opencode/g
const input = harness === 'codex' ? /Ask Codex to do anything/g : /›/g
const banners = count(banner)
console.log(`2. BYTES : ${stream.length} captured from the session stream`)
console.log('3. SCREEN: what the buffer (screen + scrollback) ends up holding')
console.log(`     interface headers : ${banners}`)
console.log(`     input boxes       : ${count(input)}`)
console.log(`     ALPHA/BRAVO/CHARLIE: ${count(/ALPHA/g)}/${count(/BRAVO/g)}/${count(/CHARLIE/g)}`)
console.log(`\nVERDICT: the interface appears ${banners} time(s) — ${banners <= 1 ? 'PASS' : 'DUPLICATED'}`)
console.log('\n--- the screen a person would be looking at ---')
for (const l of screen.split('\n').map((s) => s.trimEnd()).filter(Boolean)) console.log('  |', l)

await trpc('sessions.kill', { sessionId: sid })
ws.close()
