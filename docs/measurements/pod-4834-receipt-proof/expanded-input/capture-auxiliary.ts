// Copy the terminal's persisted edit-history objects after a run. These are
// auxiliary input histories, not receipt proof. The native history text is unmodified.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bytes, sha } from './matrix.ts'

for (const lane of process.argv.slice(2)) {
  const base = `${import.meta.dir}/${lane}`
  const run = JSON.parse(readFileSync(`${base}/run.json`, 'utf8'))
  const source = '.local/state/opencode/prompt-history.jsonl'
  const path = `${run.root}/home/${source}`
  if (!run.root.startsWith(`/tmp/podium-4984-${lane}-`)) throw new Error('Not this lane\'s scratch HOME')
  if (!existsSync(path)) { console.log(`${lane}: no auxiliary history`); continue }
  const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, n) => {
    const raw = JSON.parse(line)
    const texts = [raw.input ?? raw.text ?? '', ...(raw.parts ?? raw.pasted ?? []).map((p: any) => p.text).filter((t: any) => typeof t === 'string')]
    return { source, position: n + 1, raw, texts: texts.map(text => ({ text, bytes: bytes(text), sha256: sha(text) })) }
  })
  writeFileSync(`${base}/auxiliary-history.jsonl`, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  console.log(`${lane}: ${rows.length} auxiliary history rows`)
}
