import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildCorpus } from '../../harness/src/fixture/index'
import { startEngineFromCorpus } from '../../harness/src/engine-bootstrap'
import { createRowSource } from '../../shared/src/row-source'
import { mobxArm } from './arm'
function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}
it('hash', async () => {
  const corpus = buildCorpus(1, 4443)
  const boot = await startEngineFromCorpus(corpus)
  try {
    const source = createRowSource(boot.engine, boot.replica)
    const locals = { selectedIssueId: null as string | null, coarseNow: boot.engine.getSnapshot().coarseNow }
    const handle = mobxArm.create(source.source, locals)
    const snap = handle.snapshot()
    writeFileSync('/tmp/opencode/hash.txt', `rows=${Object.keys(snap.rowsById).length} hash=${hashString(JSON.stringify(snap))}`)
    handle.dispose(); source.dispose()
  } finally {
    boot.engine.destroy()
  }
  expect(true).toBe(true)
}, 120_000)
