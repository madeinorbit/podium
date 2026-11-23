// Drives `claude` over stream-json like claude-sdk/protocol.ts; logs every stdout line in full with its ms time.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const OUT = process.env.OUT!
const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--include-partial-messages', '--replay-user-messages',
  '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions']
const log = (dir: string, line: string) => appendFileSync(OUT, `${Date.now()}\t${dir}\t${line}\n`)
const child = spawn(process.env.CLAUDE_BIN!, args, { cwd: process.env.WORK, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const waiters: Array<(m: any) => boolean> = []
child.stdout.on('data', (d) => {
  buf += d; let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue
    let m: any; try { m = JSON.parse(line) } catch { log('RAW', line); continue }
    log('OUT', line)
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
for (const text of [...Array.from({ length: 8 }, (_, i) => 'plain ' + i), 'TEXTTOOL a', 'TEXTTOOL b']) {
  write({ type: 'user', session_id: '', uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null })
  await until((m) => m.type === 'result')
}
await Bun.sleep(1500)
child.stdin.end(); await Bun.sleep(2000)
if (!exited) child.kill()
process.exit(0)
