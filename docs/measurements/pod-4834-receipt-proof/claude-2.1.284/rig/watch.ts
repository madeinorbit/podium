// Records every line appended to any *.jsonl under DIR, with the time it was first seen (5 ms poll).
import { readdirSync, statSync, openSync, readSync, closeSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.WATCH_DIR!, OUT = process.env.WATCH_LOG!
const pos = new Map<string, number>(), rest = new Map<string, string>()
const walk = (d: string, acc: string[]) => { let es: any[] = []; try { es = readdirSync(d, { withFileTypes: true }) } catch { return acc } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walk(p, acc); else if (e.name.endsWith('.jsonl') && !p.includes('/hooks') ) acc.push(p) } return acc }
let last = Date.now(), maxGap = 0, iters = 0
for (;;) {
  const now0 = Date.now(); const gap = now0 - last; last = now0; iters++
  if (gap > 40) appendFileSync(OUT, JSON.stringify({ at: now0, watcherGapMs: gap }) + "\n")
  const files = walk(join(DIR, 'projects'), []); try { for (const e of readdirSync(DIR)) if (e.endsWith('.jsonl')) files.push(join(DIR, e)) } catch {}
  for (const f of files) {
    let size = 0; try { size = statSync(f).size } catch { continue }
    const p = pos.get(f) ?? 0
    if (size < p) { appendFileSync(OUT, JSON.stringify({ at: Date.now(), file: f, truncated: { from: p, to: size } }) + '\n'); pos.set(f, 0); rest.set(f, ''); continue }
    if (size === p) continue
    const fd = openSync(f, 'r'); const buf = Buffer.alloc(size - p); readSync(fd, buf, 0, size - p, p); closeSync(fd)
    pos.set(f, size)
    const text = (rest.get(f) ?? '') + buf.toString('utf8')
    const lines = text.split('\n'); rest.set(f, lines.pop() ?? '')
    const at = Date.now()
    for (const l of lines) if (l.trim()) appendFileSync(OUT, JSON.stringify({ at, file: f.slice(DIR.length), rec: JSON.parse(l) }) + '\n')
  }
  await Bun.sleep(5)
}
