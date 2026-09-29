// Observer for the OpenCode TUI: hooks, model requests, the TUI server's /event stream, DB rows, state files.
// Usage: bun tui-watch.ts <timeline> <port>   (runs until killed)
import { dbWatch, hookMap, log, modelMap, setOut, sleep, SP, sse, tail, WORK } from './lib.ts'
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
const [out, port] = process.argv.slice(2)
setOut(out)
const stop = new AbortController()
tail(`${SP}/logs/hooks.jsonl`, 'hook', stop.signal, hookMap)
tail(`${SP}/logs/model.jsonl`, 'model', stop.signal, modelMap)
dbWatch(stop.signal)
// Reconnect the event stream whenever it drops (the TUI restarts in S6).
;(async () => { for (;;) { const c = new AbortController(); try { const r = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { sse(`http://127.0.0.1:${port}/event?directory=${encodeURIComponent(WORK)}`, 'tui-event', c.signal); for (;;) { await sleep(1000); try { await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(1000) }) } catch { c.abort(); break } } } } catch {} await sleep(300) } })()
// Every file under the TUI's state/data dirs (not the DB, not snapshots): log appended bytes in file order.
const roots = [`${process.env.XDG_STATE_HOME}`, `${process.env.XDG_DATA_HOME}/opencode`, `${process.env.XDG_CONFIG_HOME}/opencode`]
const sizes = new Map<string, number>()
const walk = (d: string, acc: string[]) => { let es: any[] = []; try { es = readdirSync(d, { withFileTypes: true }) } catch { return } for (const e of es) { const p = `${d}/${e.name}`; if (e.isDirectory()) { if (!/snapshot|node_modules|\/log$|\/bin$/.test(p)) walk(p, acc) } else if (!/opencode\.db|\.log$/.test(p)) acc.push(p) } }
let first = true
;(async () => { for (;;) { const files: string[] = []; for (const r of roots) walk(r, files)
  for (const f of files) { let s = 0; try { s = statSync(f).size } catch { continue } const prev = sizes.get(f); if (prev === s) continue; sizes.set(f, s); if (first) continue
    let text = ''; if (prev !== undefined && s > prev) { const fd = openSync(f, 'r'); const b = Buffer.alloc(Math.min(s - prev, 4000)); readSync(fd, b, 0, b.length, prev); closeSync(fd); text = b.toString('utf8') } else { const fd = openSync(f, 'r'); const b = Buffer.alloc(Math.min(s, 4000)); readSync(fd, b, 0, b.length, 0); closeSync(fd); text = b.toString('utf8') }
    log('file', { path: f.replace(SP, '$SP'), change: prev === undefined ? 'new' : s > prev ? 'append' : 'rewrite', size: s, text }) }
  first = false; await sleep(50) } })()
