// OpenCode HTTP v2 (/api) scenarios. Usage: bun v2.ts <outfile> <scenario...>
// OC_BIN picks the binary (default opencode). V2SHAPE=beta sends {id,text,delivery} (beta-18866 driver shape);
// otherwise {id, prompt:{text}, delivery} (1.18.33 OpenAPI).
import { Api, authHeaders, dbWatch, hookMap, log, modelMap, newId, setOut, sleep, SP, sse, startServer, tail, WORK } from './lib.ts'
import type { ChildProcess } from 'node:child_process'

const [out, ...scenarios] = process.argv.slice(2)
setOut(out)
const PORT = Number(process.env.V2PORT ?? 47867)
const BIN = process.env.OC_BIN ?? 'opencode'
const BETA = process.env.V2SHAPE === 'beta'
const stop = new AbortController()
tail(`${SP}/logs/hooks.jsonl`, 'hook', stop.signal, hookMap)
tail(`${SP}/logs/model.jsonl`, 'model', stop.signal, modelMap)
dbWatch(stop.signal)
let server: ChildProcess = await startServer(BIN, PORT, 'v2')
const api = new Api(`http://127.0.0.1:${PORT}`)
const streams: AbortController[] = []
const openGlobal = () => { const c = new AbortController(); streams.push(c); sse(`http://127.0.0.1:${PORT}/api/event`, 'api-event', c.signal) }
const openSession = (sid: string) => { const c = new AbortController(); streams.push(c); sse(`http://127.0.0.1:${PORT}/api/session/${sid}/event?after=0`, `sess-event`, c.signal) }
const closeAll = () => { for (const c of streams.splice(0)) c.abort() }
openGlobal()
await sleep(500)

const mark = (name: string, extra: Record<string, unknown> = {}) => log('mark', { name, ...extra })
const live = new Set<string>()
const newSession = async (title: string) => {
  const r = await api.call('POST', '/api/session', { title, location: { directory: WORK } }, 'create')
  const sid = r.json?.data?.id as string
  live.add(sid); openSession(sid); await sleep(200); return sid
}
const prompt = (sid: string, id: string | undefined, text: string, label: string, delivery: 'queue' | 'steer' = 'queue') =>
  api.call('POST', `/api/session/${sid}/prompt`, BETA ? { ...(id ? { id } : {}), text, delivery } : { ...(id ? { id } : {}), prompt: { text }, delivery }, label)
const messages = (sid: string, label: string) => api.call('GET', `/api/session/${sid}/message?order=asc&limit=200`, undefined, label)
const active = (label: string) => api.call('GET', '/api/session/active', undefined, label)
const waitIdle = async (sid: string, maxMs = 40000) => {
  const t = Date.now(); await sleep(400)
  while (Date.now() - t < maxMs) {
    const a = await fetch(`http://127.0.0.1:${PORT}/api/session/active`, { headers: authHeaders }).then((r) => r.json()).catch(() => null) as any
    const busy = JSON.stringify(a ?? '').includes(sid)
    if (!busy) { log('idle', { sid }); return true }
    await sleep(250)
  }
  log('idle.timeout', { sid }); return false
}
const restart = async (tag: string) => {
  closeAll(); server.kill('SIGKILL'); await sleep(1000)
  server = await startServer(BIN, PORT, tag); openGlobal(); for (const s of live) openSession(s); await sleep(1000)
}

const S: Record<string, () => Promise<void>> = {
  async s1() {
    const sid = await newSession('v2 S1 idle'); const id = newId()
    mark('S1.send', { sid, id }); await prompt(sid, id, 'V2S1 ALPHA idle queue', 'S1')
    await waitIdle(sid); await messages(sid, 'S1.after')
    const id2 = newId()
    mark('S1s.send', { sid, id: id2 }); await prompt(sid, id2, 'V2S1s ALPHA idle steer', 'S1s', 'steer')
    await waitIdle(sid); await messages(sid, 'S1s.after')
  },
  async s2() {
    for (const d of ['queue', 'steer'] as const) {
      const sid = await newSession(`v2 S2 busy tool ${d}`); const a = newId(), b = newId()
      mark(`S2${d}.sendA`, { sid, id: a }); await prompt(sid, a, `V2S2${d} BETA TOOLSLEEP please`, `S2${d}.A`)
      await sleep(2500)
      mark(`S2${d}.sendB`, { sid, id: b }); await prompt(sid, b, `V2S2${d} GAMMA while the tool runs`, `S2${d}.B`, d)
      await messages(sid, `S2${d}.right-after-B`)
      await waitIdle(sid); await messages(sid, `S2${d}.after`)
    }
  },
  async s3() {
    for (const d of ['queue', 'steer'] as const) {
      const sid = await newSession(`v2 S3 busy text ${d}`); const a = newId(), b = newId()
      mark(`S3${d}.sendA`, { sid, id: a }); await prompt(sid, a, `V2S3${d} DELTA SLOWTEXT please`, `S3${d}.A`)
      await sleep(3000)
      mark(`S3${d}.sendB`, { sid, id: b }); await prompt(sid, b, `V2S3${d} EPSILON while text streams`, `S3${d}.B`, d)
      await messages(sid, `S3${d}.right-after-B`)
      await waitIdle(sid); await messages(sid, `S3${d}.after`)
    }
  },
  async s4() {
    for (const d of ['queue', 'steer'] as const) {
      const sid = await newSession(`v2 S4 interrupt ${d}`); const a = newId(), b = newId(), c = newId()
      mark(`S4${d}.sendA`, { sid, id: a }); await prompt(sid, a, `V2S4${d} ZETA TOOLSLEEP please`, `S4${d}.A`)
      await sleep(2000)
      mark(`S4${d}.sendB`, { sid, id: b }); await prompt(sid, b, `V2S4${d} ETA pending behind the tool`, `S4${d}.B`, d)
      await sleep(500)
      mark(`S4${d}.interrupt`, { sid }); await api.call('POST', `/api/session/${sid}/interrupt`, undefined, `S4${d}.interrupt`)
      await sleep(3000); await messages(sid, `S4${d}.after-interrupt`); await active(`S4${d}.active`)
      await waitIdle(sid); await messages(sid, `S4${d}.after-interrupt-idle`)
      mark(`S4${d}.sendC`, { sid, id: c }); await prompt(sid, c, `V2S4${d} THETA after the interrupt`, `S4${d}.C`)
      await waitIdle(sid); await messages(sid, `S4${d}.after`)
    }
  },
  async s5() {
    const sid = await newSession('v2 S5 same id'); const m = newId()
    mark('S5a.first', { sid, id: m }); await prompt(sid, m, 'V2S5 IOTA first', 'S5a.1'); await waitIdle(sid)
    mark('S5a.repeat', { sid, id: m }); await prompt(sid, m, 'V2S5 IOTA first', 'S5a.2'); await sleep(2500); await waitIdle(sid); await messages(sid, 'S5a.after')
    mark('S5d.difftext', { sid, id: m }); await prompt(sid, m, 'V2S5 IOTA DIFFERENT text same id', 'S5d.2'); await sleep(2500); await waitIdle(sid); await messages(sid, 'S5d.after')
    const m3 = newId()
    mark('S5c.both', { sid, id: m3 })
    await Promise.all([prompt(sid, m3, 'V2S5 LAMBDA twice at once', 'S5c.1'), prompt(sid, m3, 'V2S5 LAMBDA twice at once', 'S5c.2')])
    await sleep(1000); await waitIdle(sid); await messages(sid, 'S5c.after')
    // Repeat while the first is still pending behind a busy turn.
    const a = newId(), m5 = newId()
    mark('S5e.busy', { sid, id: a }); await prompt(sid, a, 'V2S5 NU TOOLSLEEP please', 'S5e.A'); await sleep(2000)
    mark('S5e.first', { sid, id: m5 }); await prompt(sid, m5, 'V2S5 XI pending', 'S5e.1')
    mark('S5e.repeat-same', { sid, id: m5 }); await prompt(sid, m5, 'V2S5 XI pending', 'S5e.2same')
    mark('S5e.repeat', { sid, id: m5 }); await prompt(sid, m5, 'V2S5 XI pending but another text', 'S5e.2')
    await waitIdle(sid); await messages(sid, 'S5e.after')
    // Same id in another session.
    const other = await newSession('v2 S5 other')
    mark('S5f.cross', { sid: other, id: m }); await prompt(other, m, 'V2S5 IOTA reused in another session', 'S5f.cross'); await sleep(2500); await waitIdle(other); await messages(other, 'S5f.other-after'); await messages(sid, 'S5f.sid-after')
  },
  async s6() {
    const sid = await newSession('v2 S6 restart')
    // (a) idle send, SIGKILL right after the 200.
    const c = newId()
    mark('S6a.send', { sid, id: c }); await prompt(sid, c, 'V2S6 OMICRON SLOWTEXT then the server dies', 'S6a')
    mark('S6a.kill'); await restart('v2-restarted-a')
    await messages(sid, 'S6a.after-restart'); await active('S6a.active-after-restart')
    await sleep(12000); await messages(sid, 'S6a.after-wait'); await active('S6a.active-after-wait')
    await waitIdle(sid)
    // (b) busy: queue B behind a tool, SIGKILL right after B's 200.
    const a = newId(), b = newId()
    mark('S6b.sendA', { sid, id: a }); await prompt(sid, a, 'V2S6 PI TOOLSLEEP please', 'S6b.A'); await sleep(2500)
    mark('S6b.sendB', { sid, id: b }); await prompt(sid, b, 'V2S6 RHO queued then the server dies', 'S6b.B')
    mark('S6b.kill'); await restart('v2-restarted-b')
    await messages(sid, 'S6b.after-restart'); await active('S6b.active-after-restart')
    await sleep(15000); await messages(sid, 'S6b.after-wait'); await active('S6b.active-after-wait')
    await waitIdle(sid)
    const d = newId()
    mark('S6c.send', { sid, id: d }); await prompt(sid, d, 'V2S6 SIGMA after two restarts', 'S6c'); await waitIdle(sid); await messages(sid, 'S6c.after')
    // (d) the same id as (a) again after the restarts.
    mark('S6d.repeat-a', { sid, id: c }); await prompt(sid, c, 'V2S6 OMICRON SLOWTEXT then the server dies', 'S6d'); await sleep(2000); await waitIdle(sid); await messages(sid, 'S6d.after')
  },
  async s5p() {
    // Same id, same text, while the first is still pending behind a busy turn.
    const sid = await newSession('v2 S5p pending repeat'); const a = newId(), m = newId()
    mark('S5p.busy', { sid, id: a }); await prompt(sid, a, 'V2S5p NU TOOLSLEEP please', 'S5p.A'); await sleep(2000)
    mark('S5p.first', { sid, id: m }); await prompt(sid, m, 'V2S5p XI pending', 'S5p.1')
    mark('S5p.repeat-same', { sid, id: m }); await prompt(sid, m, 'V2S5p XI pending', 'S5p.2')
    await waitIdle(sid); await messages(sid, 'S5p.after')
  },
  async s6e() {
    // Recovery: an admitted input left pending by a kill. Does a resend of the same id run it? Does resume:true?
    const sid = await newSession('v2 S6e recovery'); const c = newId()
    mark('S6e.send', { sid, id: c }); await prompt(sid, c, 'V2S6e PHI idle then the server dies', 'S6e.1')
    mark('S6e.kill'); await restart('v2-restarted-e')
    await messages(sid, 'S6e.after-restart')
    mark('S6e.repeat', { sid, id: c }); await prompt(sid, c, 'V2S6e PHI idle then the server dies', 'S6e.2')
    await sleep(6000); await messages(sid, 'S6e.after-repeat'); await active('S6e.active-after-repeat')
    if (!BETA) {
      mark('S6e.resume', { sid, id: c })
      await api.call('POST', `/api/session/${sid}/prompt`, { id: c, prompt: { text: 'V2S6e PHI idle then the server dies' }, delivery: 'queue', resume: true }, 'S6e.3resume')
      await sleep(6000); await messages(sid, 'S6e.after-resume')
    }
    await waitIdle(sid)
  },
  async s7() {
    const sid = await newSession('v2 S7 text')
    const texts: Record<string, string> = {
      ws: '  S7 leading and trailing spaces  \t ',
      nl: 'S7 line one\n\n  line three indented\r\nline four crlf\n',
      uni: 'S7 unicode é ü 日本語 🙂 zero​width combining é rtl א',
      long: 'S7 LONG ' + Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' '),
    }
    for (const [k, t] of Object.entries(texts)) { const id = newId(); mark(`S7.${k}`, { sid, id, len: t.length }); await prompt(sid, id, t, `S7.${k}`); await waitIdle(sid) }
    await messages(sid, 'S7.after')
  },
  async s10() {
    const sid = await newSession('v2 S10 errors')
    mark('S10.badid'); await prompt(sid, 'msgbad1', 'V2S10 bad id', 'S10.badid')
    mark('S10.nodelivery'); await api.call('POST', `/api/session/${sid}/prompt`, BETA ? { id: newId(), text: 'V2S10 bad delivery', delivery: 'later' } : { id: newId(), prompt: { text: 'V2S10 bad delivery' }, delivery: 'later' }, 'S10.baddelivery')
    mark('S10.v1shape'); await api.call('POST', `/api/session/${sid}/prompt`, { id: newId(), text: 'V2S10 other shape', delivery: 'queue' }, 'S10.othershape')
    mark('S10.nosession'); await prompt('ses_doesnotexist000000000000', newId(), 'V2S10 unknown session', 'S10.nosession')
    await sleep(1500); await messages(sid, 'S10.after')
  },
}

for (const s of scenarios) { mark(`${s}.begin`); try { await S[s]!() } catch (e) { log('scenario.error', { s, err: String(e) }) } mark(`${s}.end`); await sleep(1500) }
await sleep(1000)
stop.abort(); closeAll(); server.kill('SIGTERM'); await sleep(500)
process.exit(0)
