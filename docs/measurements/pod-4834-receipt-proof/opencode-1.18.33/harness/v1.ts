// OpenCode HTTP v1 scenarios. Usage: bun v1.ts <outfile> <scenario...>
import { Api, dbWatch, hookMap, log, modelMap, newId, partIdFor, setOut, sleep, SP, sse, startServer, tail, WORK } from './lib.ts'
import type { ChildProcess } from 'node:child_process'

const [out, ...scenarios] = process.argv.slice(2)
setOut(out)
const PORT = 47866
const BIN = process.env.OC_BIN ?? 'opencode'
const stop = new AbortController()
tail(`${SP}/logs/hooks.jsonl`, 'hook', stop.signal, hookMap)
tail(`${SP}/logs/model.jsonl`, 'model', stop.signal, modelMap)
dbWatch(stop.signal)
let server: ChildProcess = await startServer(BIN, PORT, 'v1')
const api = new Api(`http://127.0.0.1:${PORT}`)
let sseStop = new AbortController()
const openSse = () => { sseStop = new AbortController(); sse(`http://127.0.0.1:${PORT}/event?directory=${encodeURIComponent(WORK)}`, 'v1-event', sseStop.signal) }
openSse()
await sleep(500)

const mark = (name: string, extra: Record<string, unknown> = {}) => log('mark', { name, ...extra })
const newSession = async (title: string) => (await api.call('POST', '/session', { title }, 'create')).json.id as string
const promptAsync = (sid: string, id: string | undefined, text: string, label: string, fixedPart = true) =>
  api.call('POST', `/session/${sid}/prompt_async`, { ...(id ? { messageID: id } : {}), parts: [{ type: 'text', text, ...(id && fixedPart ? { id: partIdFor(id) } : {}) }] }, label)
const status = async (label: string) => api.call('GET', '/session/status', undefined, label)
const messages = async (sid: string, label: string) => api.call('GET', `/session/${sid}/message`, undefined, label)
const waitIdle = async (sid: string, maxMs = 40000) => {
  // Idle = not in /session/status AND the newest message is an assistant message with time.completed.
  const t = Date.now()
  await sleep(300)
  while (Date.now() - t < maxMs) {
    const st = await fetch(api.q('/session/status')).then((r) => r.json()).catch(() => ({})) as any
    if (!st?.[sid]) {
      const ms = await fetch(api.q(`/session/${sid}/message`)).then((r) => r.json()).catch(() => []) as any[]
      const last = ms.at(-1)?.info
      if (last?.role === 'assistant' && last?.time?.completed) { log('idle', { sid, lastId: last.id }); return true }
    }
    await sleep(250)
  }
  log('idle.timeout', { sid }); return false
}

const S: Record<string, () => Promise<void>> = {
  async s1() {
    const sid = await newSession('S1 idle'); const id = newId()
    mark('S1.send', { sid, id })
    await promptAsync(sid, id, 'S1 ALPHA idle send', 'S1')
    await waitIdle(sid); await messages(sid, 'S1.after')
  },
  async s1w() {
    const sid = await newSession('S1w idle warm'); const id = newId()
    mark('S1w.send', { sid, id })
    await promptAsync(sid, id, 'S1w ALPHA2 idle send, warm server', 'S1w')
    await waitIdle(sid); await messages(sid, 'S1w.after')
  },
  async s2() {
    const sid = await newSession('S2 busy tool'); const a = newId(), b = newId()
    mark('S2.sendA', { sid, id: a })
    await promptAsync(sid, a, 'S2 BETA TOOLSLEEP please', 'S2.A')
    await sleep(2500)
    mark('S2.sendB', { sid, id: b })
    await promptAsync(sid, b, 'S2 GAMMA sent while the tool runs', 'S2.B')
    await status('S2.status-after-B')
    await waitIdle(sid); await messages(sid, 'S2.after')
  },
  async s3() {
    const sid = await newSession('S3 busy text'); const a = newId(), b = newId()
    mark('S3.sendA', { sid, id: a })
    await promptAsync(sid, a, 'S3 DELTA SLOWTEXT please', 'S3.A')
    await sleep(3000)
    mark('S3.sendB', { sid, id: b })
    await promptAsync(sid, b, 'S3 EPSILON sent while text streams', 'S3.B')
    await waitIdle(sid); await messages(sid, 'S3.after')
  },
  async s4() {
    const sid = await newSession('S4 interrupt'); const a = newId(), b = newId(), c = newId()
    mark('S4.sendA', { sid, id: a })
    await promptAsync(sid, a, 'S4 ZETA TOOLSLEEP please', 'S4.A')
    await sleep(2000)
    mark('S4.sendB', { sid, id: b })
    await promptAsync(sid, b, 'S4 ETA queued behind the tool', 'S4.B')
    await sleep(500)
    mark('S4.abort', { sid })
    await api.call('POST', `/session/${sid}/abort`, {}, 'S4.abort')
    await sleep(1500)
    await messages(sid, 'S4.after-abort')
    mark('S4.sendC', { sid, id: c })
    await promptAsync(sid, c, 'S4 THETA after the interrupt', 'S4.C')
    await waitIdle(sid); await messages(sid, 'S4.after')
  },
  async s5() {
    // (a) same id + same fixed part id, after the first turn ended. (b) same id, NO part id. (c) same id twice back to back.
    const sid = await newSession('S5 same id'); const m = newId()
    mark('S5a.first', { sid, id: m })
    await promptAsync(sid, m, 'S5 IOTA first', 'S5a.1')
    await waitIdle(sid)
    mark('S5a.repeat', { sid, id: m })
    await promptAsync(sid, m, 'S5 IOTA first', 'S5a.2')
    await sleep(3000); await waitIdle(sid); await messages(sid, 'S5a.after')
    const m2 = newId()
    mark('S5b.first', { sid, id: m2 })
    await promptAsync(sid, m2, 'S5 KAPPA no part id', 'S5b.1', false)
    await waitIdle(sid)
    mark('S5b.repeat', { sid, id: m2 })
    await promptAsync(sid, m2, 'S5 KAPPA no part id', 'S5b.2', false)
    await sleep(3000); await waitIdle(sid); await messages(sid, 'S5b.after')
    const m3 = newId()
    mark('S5c.both', { sid, id: m3 })
    await Promise.all([promptAsync(sid, m3, 'S5 LAMBDA twice at once', 'S5c.1'), promptAsync(sid, m3, 'S5 LAMBDA twice at once', 'S5c.2')])
    await sleep(3000); await waitIdle(sid); await messages(sid, 'S5c.after')
    const m4 = newId()
    mark('S5d.difftext', { sid, id: m4 })
    await promptAsync(sid, m4, 'S5 MU original text', 'S5d.1')
    await waitIdle(sid)
    await promptAsync(sid, m4, 'S5 MU DIFFERENT text same ids', 'S5d.2')
    await sleep(3000); await waitIdle(sid); await messages(sid, 'S5d.after')
  },
  async s6() {
    // Busy in a tool, queue B, SIGKILL the server 200 ms after B's 204, restart, read history, then wait.
    const sid = await newSession('S6 restart'); const a = newId(), b = newId()
    mark('S6.sendA', { sid, id: a })
    await promptAsync(sid, a, 'S6 NU TOOLSLEEP please', 'S6.A')
    await sleep(2500)
    mark('S6.sendB', { sid, id: b })
    await promptAsync(sid, b, 'S6 XI queued then the server dies', 'S6.B')
    await sleep(200)
    mark('S6.kill', { pid: server.pid })
    sseStop.abort(); server.kill('SIGKILL'); await sleep(1000)
    server = await startServer(BIN, PORT, 'v1-restarted'); openSse(); await sleep(1000)
    await messages(sid, 'S6.after-restart'); await status('S6.status-after-restart')
    await sleep(15000)
    await messages(sid, 'S6.after-wait'); await status('S6.status-after-wait')
    // Idle send, then kill 50 ms after the 204 (before the model answers).
    const c = newId()
    mark('S6.sendC-idle', { sid, id: c })
    await promptAsync(sid, c, 'S6 OMICRON SLOWTEXT then the server dies', 'S6.C')
    await sleep(50)
    mark('S6.kill2', { pid: server.pid })
    sseStop.abort(); server.kill('SIGKILL'); await sleep(1000)
    server = await startServer(BIN, PORT, 'v1-restarted2'); openSse(); await sleep(1000)
    await messages(sid, 'S6.after-restart2'); await status('S6.status-after-restart2')
    await sleep(8000); await messages(sid, 'S6.after-wait2')
    const d = newId()
    mark('S6.sendD', { sid, id: d })
    await promptAsync(sid, d, 'S6 PI after two restarts', 'S6.D')
    await waitIdle(sid); await messages(sid, 'S6.after-D')
  },
  async s6r() {
    // Recovery: B stored behind a tool, server killed, restarted. Does a resend of B's ids run it?
    const sid = await newSession('S6r recovery'); const a = newId(), b = newId()
    mark('S6r.sendA', { sid, id: a }); await promptAsync(sid, a, 'S6r NU TOOLSLEEP please', 'S6r.A')
    await sleep(2500)
    mark('S6r.sendB', { sid, id: b }); await promptAsync(sid, b, 'S6r XI stored then the server dies', 'S6r.B')
    await sleep(300)
    mark('S6r.kill', { pid: server.pid }); sseStop.abort(); server.kill('SIGKILL'); await sleep(1000)
    server = await startServer(BIN, PORT, 'v1-restarted-r'); openSse(); await sleep(1000)
    await messages(sid, 'S6r.after-restart')
    mark('S6r.repeatB', { sid, id: b }); await promptAsync(sid, b, 'S6r XI stored then the server dies', 'S6r.B2')
    await sleep(1000); await waitIdle(sid); await messages(sid, 'S6r.after-repeat')
  },
  async s7() {
    const sid = await newSession('S7 text')
    const texts: Record<string, string> = {
      ws: '  S7 leading and trailing spaces  \t ',
      nl: 'S7 line one\n\n  line three indented\r\nline four crlf\n',
      uni: 'S7 unicode é ü 日本語 🙂 zero​width combining é rtl א',
      long: 'S7 LONG ' + Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' '),
    }
    for (const [k, t] of Object.entries(texts)) {
      const id = newId(); mark(`S7.${k}`, { sid, id, len: t.length, text: t.length > 300 ? `${t.slice(0, 100)}…` : t })
      await promptAsync(sid, id, t, `S7.${k}`); await waitIdle(sid)
    }
    await messages(sid, 'S7.after')
  },
  async s10() {
    const sid = await newSession('S10 errors')
    mark('S10.badid'); await promptAsync(sid, 'bad_id_1', 'S10 RHO bad message id', 'S10.badid')
    mark('S10.badbody'); await api.call('POST', `/session/${sid}/prompt_async`, { parts: [{ type: 'nope', text: 'S10 SIGMA bad part' }] }, 'S10.badbody')
    mark('S10.nosession'); await promptAsync('ses_doesnotexist000000000000', newId(), 'S10 TAU unknown session', 'S10.nosession')
    const other = await newSession('S10 other'); const m = newId()
    await promptAsync(other, m, 'S10 UPSILON in other session', 'S10.other'); await waitIdle(other)
    mark('S10.crosssession', { sid, id: m })
    await promptAsync(sid, m, 'S10 UPSILON id reused in this session', 'S10.cross')
    await sleep(3000); await waitIdle(sid); await waitIdle(other)
    await messages(sid, 'S10.after'); await messages(other, 'S10.other-after')
  },
}

for (const s of scenarios) { mark(`${s}.begin`); try { await S[s]!() } catch (e) { log('scenario.error', { s, err: String(e) }) } mark(`${s}.end`); await sleep(1500) }
await sleep(1000)
stop.abort(); sseStop.abort(); server.kill('SIGTERM'); await sleep(500)
process.exit(0)
