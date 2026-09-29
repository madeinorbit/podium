// Polls every *.jsonl/*.json file under WATCH_DIR every 20 ms and logs what changed, with the
// time it was first SEEN (the write time to within one poll), in file order:
//   jsonl, grown by appending      -> one {rec} line per new complete line
//   jsonl, earlier content changed -> {rewritten:{inodeChanged, oldLines, newLines, firstDiffLine}}
//                                     and then every line from the first difference as {rec, relined:true}
//   json, content changed           -> {json}
// tool_definitions.json is skipped (large, static).
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
const DIR = process.env.WATCH_DIR!
const LOG = process.env.WATCH_LOG!
const seen = new Map<string, { content: string; ino: number }>()
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
const parse = (line: string): unknown => { try { return JSON.parse(line) } catch { return line } }
// WATCH_SKIP_INITIAL=1: the first poll only records what exists (restart without re-logging).
let quiet = process.env.WATCH_SKIP_INITIAL === '1'
const emit = (o: unknown) => { if (!quiet) appendFileSync(LOG, JSON.stringify(o) + '\n') }
const tick = () => {
  const at = Date.now()
  for (const f of walk(DIR)) {
    const file = relative(DIR, f)
    let content = ''
    let ino = 0
    try { ino = statSync(f).ino; content = readFileSync(f, 'utf8') } catch { continue }
    const prev = seen.get(f)
    if (prev && prev.content === content && prev.ino === ino) continue
    if (f.endsWith('.json')) {
      if (prev?.content !== content) emit({ at, file, json: parse(content) })
      seen.set(f, { content, ino })
      continue
    }
    // jsonl: only complete lines count
    const complete = content.slice(0, content.lastIndexOf('\n') + 1)
    const old = prev?.content ?? ''
    if (complete === old && prev?.ino === ino) continue
    if (complete.startsWith(old)) {
      if (prev && prev.ino !== ino) emit({ at, file, inodeChanged: true, appendOnly: true })
      for (const line of complete.slice(old.length).split('\n').filter(Boolean)) emit({ at, file, rec: parse(line) })
    } else {
      const a = old.split('\n').filter(Boolean)
      const b = complete.split('\n').filter(Boolean)
      let i = 0
      while (i < a.length && i < b.length && a[i] === b[i]) i++
      emit({ at, file, rewritten: { inodeChanged: prev?.ino !== ino, oldLines: a.length, newLines: b.length, firstDiffLine: i + 1, replacedOld: a.slice(i).map(parse) } })
      for (const line of b.slice(i)) emit({ at, file, rec: parse(line), relined: true })
    }
    seen.set(f, { content: complete, ino })
  }
}
tick()
quiet = false
setInterval(tick, 20)
