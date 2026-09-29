// Drives `claude` over stream-json the way packages/harness/src/driver/families/claude-sdk/protocol.ts
// spawns it, logging every frame both ways with its time (ms epoch) to $OUT.
// STEPS (JSON array): {send:{text,uuid,priority?}} | {sleep:ms} | {until:"result"|"<type>/<subtype>",ms?}
//   | {interrupt:true} | {kill9:true} | {close:true} | {mark:"LABEL"}
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const OUT = process.env.OUT!, MARKS = process.env.MARKS!
const extra = (process.env.EXTRA ?? '').split(' ').filter(Boolean)
const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--include-partial-messages', '--replay-user-messages',
  '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', ...extra]
const log = (dir: string, line: string) => appendFileSync(OUT, `${Date.now()}\t${dir}\t${line}\n`)
const mark = (l: string) => appendFileSync(MARKS, `${l} ${Date.now()}\n`)
log('ARGS', JSON.stringify(args))
const child = spawn('claude', args, { cwd: process.env.WORK, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const waiters: Array<(m: any) => boolean> = []
child.stdout.on('data', (d) => {
  buf += d; let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue
    let m: any; try { m = JSON.parse(line) } catch { log('RAW', line); continue }
    if (m.type === 'stream_event') { const e = m.event; log('SE', `${e?.type}${e?.delta?.text ? ' ' + e.delta.text : ''}${e?.content_block?.type ? ' ' + e.content_block.type : ''}`); }
    else log('OUT', line.length > 4000 ? line.slice(0, 4000) + '…' : line)
    for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k](m)) waiters.splice(k, 1)
  }
})
child.stderr.on('data', (d) => log('ERR', String(d).trim()))
let exited = false
child.on('exit', (c, s) => { exited = true; log('EXIT', `${c} ${s}`) })
const write = (o: any) => { const l = JSON.stringify(o); log('IN', l); child.stdin.write(l + '\n') }
const until = (pred: (m: any) => boolean, ms = 30000) => new Promise<any>((res) => { const t = setTimeout(() => { log('NOTE', 'until timed out'); res(null) }, ms); waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); return true } return false }) })
write({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } })
await until((m) => m.type === 'control_response')
let ctl = 0
for (const s of JSON.parse(process.env.STEPS!) as any[]) {
  if (exited) break
  if (s.mark) mark(s.mark)
  if (s.send) write({ type: 'user', session_id: '', uuid: s.send.uuid, ...(s.send.priority ? { priority: s.send.priority } : {}), message: { role: 'user', content: [{ type: 'text', text: s.send.text }] }, parent_tool_use_id: null })
  if (s.sleep) await Bun.sleep(s.sleep)
  if (s.until) { const [t, st] = s.until.split('/'); await until((m) => m.type === t && (!st || m.subtype === st), s.ms ?? 30000) }
  if (s.interrupt) write({ type: 'control_request', request_id: `int-${++ctl}`, request: { subtype: 'interrupt' } })
  if (s.kill9) { log('NOTE', 'SIGKILL'); child.kill('SIGKILL') }
  if (s.close) { log('NOTE', 'stdin end'); child.stdin.end() }
}
await Bun.sleep(1500)
if (!exited) { child.stdin.end(); await Bun.sleep(3000) }
if (!exited) child.kill()
process.exit(0)
