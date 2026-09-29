// Polls every *.jsonl/*.json file under WATCH_DIR every 20 ms and logs each new line (jsonl)
// or each content change (json) with the time it was first SEEN — the write time to within
// one poll, in file order. Output: one JSON line per observation to WATCH_LOG.
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
const DIR = process.env.WATCH_DIR!
const LOG = process.env.WATCH_LOG!
const offsets = new Map<string, number>()
const jsonSeen = new Map<string, string>()
const walk = (d: string): string[] => {
  let out: string[] = []
  let entries: any[] = []
  try { entries = readdirSync(d, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(d, e.name)
    if (e.isDirectory()) out = out.concat(walk(p))
    else if (/\.(jsonl|json)$/.test(e.name) && e.name !== 'tool_definitions.json') out.push(p)
  }
  return out
}
const tick = () => {
  const at = Date.now()
  for (const f of walk(DIR)) {
    const rel = relative(DIR, f)
    let size = 0
    try { size = statSync(f).size } catch { continue }
    if (f.endsWith('.jsonl')) {
      const off = offsets.get(f) ?? 0
      if (size < off) { appendFileSync(LOG, JSON.stringify({ at, file: rel, truncated: { from: off, to: size } }) + '\n'); offsets.set(f, 0); continue }
      if (size === off) continue
      const buf = readFileSync(f).subarray(off)
      const text = buf.toString('utf8')
      const lastNl = text.lastIndexOf('\n')
      if (lastNl < 0) continue
      for (const line of text.slice(0, lastNl).split('\n')) {
        let rec: unknown = line
        try { rec = JSON.parse(line) } catch {}
        appendFileSync(LOG, JSON.stringify({ at, file: rel, rec }) + '\n')
      }
      offsets.set(f, off + Buffer.byteLength(text.slice(0, lastNl + 1)))
    } else {
      let content = ''
      try { content = readFileSync(f, 'utf8') } catch { continue }
      if (jsonSeen.get(f) === content) continue
      jsonSeen.set(f, content)
      let rec: unknown = content
      try { rec = JSON.parse(content) } catch {}
      appendFileSync(LOG, JSON.stringify({ at, file: rel, json: rec }) + '\n')
    }
  }
}
setInterval(tick, 20)
