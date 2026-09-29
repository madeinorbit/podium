// Raw ACP probe of `grok agent stdio` (POD-4837): logs every frame with its time. P=<scratch> RUN=<name> MODE=basic|busy|repeatbusy|hook|fail|fixture bun acp-probe.ts
// Raw ACP probe of `grok agent stdio`: timestamps every frame relative to each send.
import { appendFileSync } from 'node:fs'

const P = process.env.P!
const out = `${P}/logs/${process.env.RUN ?? 'run'}.jsonl`
const t0 = performance.now()
const now = () => +(performance.now() - t0).toFixed(1)
const proc = Bun.spawn(['grok', 'agent', 'stdio'], {
  cwd: `${P}/work`,
  env: { ...process.env, HOME: `${P}/home`, GROK_HOME: `${P}/home/.grok`, FAKE_KEY: 'dummy' },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})
const rec = (dir: string, frame: unknown) =>
  appendFileSync(out, `${JSON.stringify({ t: now(), dir, frame })}\n`)
let nextId = 1
const waiting = new Map<number, (v: any) => void>()
const listeners: ((f: any) => void)[] = []
;(async () => {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk)
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let f: any
      try {
        f = JSON.parse(line)
      } catch {
        rec('in-raw', line)
        continue
      }
      rec('in', f)
      for (const l of listeners) l(f)
      if (f.id !== undefined && f.method === undefined) waiting.get(f.id)?.(f)
      if (f.id !== undefined && f.method === 'session/request_permission') {
        const opt =
          f.params.options.find((o: any) => o.kind === 'allow_once') ?? f.params.options[0]
        send({ id: f.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } })
      }
    }
  }
})()
;(async () => {
  for await (const c of proc.stderr)
    appendFileSync(`${P}/logs/${process.env.RUN ?? 'run'}.stderr`, c)
})()
function send(frame: any) {
  rec('out', frame)
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  proc.stdin.flush()
}
function call(method: string, params: any): Promise<any> {
  const id = nextId++
  const p = new Promise((r) => waiting.set(id, r))
  send({ id, method, params })
  return p
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function mark(label: string) {
  rec('mark', label)
}
const _init = await call('initialize', {
  protocolVersion: 1,
  clientInfo: { name: 'Podium', version: '1' },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
})
const mode = process.env.MODE ?? 'basic'
let sid: string
if (process.env.LOAD) {
  sid = process.env.LOAD
  mark('load')
  await call('session/load', { sessionId: sid, cwd: `${P}/work`, mcpServers: [] })
  await sleep(1500)
} else {
  const s = await call('session/new', { cwd: `${P}/work`, mcpServers: [] })
  sid = s.result.sessionId
}
appendFileSync(`${P}/logs/sid`, `${sid}\n`)
const prompt = (text: string, extra: any = {}) =>
  call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }], ...extra })
if (mode === 'basic') {
  mark('A promptId meta')
  await prompt('alpha one', { _meta: { promptId: 'podmsg-A' } })
  await sleep(1500)
  mark('B messageId')
  await prompt('bravo two', { messageId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })
  await sleep(1500)
  mark('C repeat promptId A')
  await prompt('alpha one', { _meta: { promptId: 'podmsg-A' } })
  await sleep(1500)
  mark('D plain')
  await prompt('delta four')
  await sleep(1500)
} else if (mode === 'busy') {
  mark('E first')
  const e = prompt('echo five', { _meta: { promptId: 'podmsg-E' } })
  await sleep(300)
  mark('F while busy')
  const f = prompt('foxtrot six', { _meta: { promptId: 'podmsg-F' } })
  await Promise.all([e, f])
  await sleep(1500)
} else if (mode === 'repeatbusy') {
  mark('G first')
  const g = prompt('golf seven', { _meta: { promptId: 'podmsg-G' } })
  await sleep(300)
  mark('G repeat while busy')
  const g2 = prompt('golf seven', { _meta: { promptId: 'podmsg-G' } })
  await Promise.all([g, g2])
  await sleep(1500)
} else if (mode === 'hook') {
  mark('H allowed')
  await prompt('hotel eight', { _meta: { promptId: 'podmsg-H' } })
  await sleep(1500)
  mark('I blocked')
  await prompt('india blockme', { _meta: { promptId: 'podmsg-I' } })
  await sleep(1500)
  mark('J after block')
  await prompt('juliet ten', { _meta: { promptId: 'podmsg-J' } })
  await sleep(1500)
} else if (mode === 'fail') {
  mark('K 402')
  await prompt('kilo fail402', { _meta: { promptId: 'podmsg-K' } })
  await sleep(1500)
} else if (mode === 'fixture') {
  await call('session/set_mode', { sessionId: sid, modeId: 'default' })
  mark('1 plain prompt carrying our promptId')
  await prompt('say hello', { _meta: { promptId: 'msg_01fixture-hello' } })
  await sleep(800)
  mark('2 tool call asks permission')
  await prompt('toolme please', { _meta: { promptId: 'msg_02fixture-tool' } })
  await sleep(800)
  mark('3 cancel mid-stream')
  const c = prompt('slowme please', { _meta: { promptId: 'msg_03fixture-cancel' } })
  await new Promise<void>((r) => {
    listeners.push((f) => {
      if (
        f.params?.update?.sessionUpdate === 'agent_message_chunk' &&
        f.params?._meta?.promptId === 'msg_03fixture-cancel'
      )
        r()
    })
  })
  send({ method: 'session/cancel', params: { sessionId: sid } })
  await c
  await sleep(800)
  mark('4 the same promptId again')
  await prompt('say hello', { _meta: { promptId: 'msg_01fixture-hello' } })
  await sleep(800)
} else if (mode === 'nop') {
  await sleep(1000)
}
mark('end')
proc.kill()
await sleep(300)
process.exit(0)
