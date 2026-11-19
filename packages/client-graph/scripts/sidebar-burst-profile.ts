// POD-7173: what the drawn sidebar does per burst while a large flat tree
// arrives. A pool holds a measurement corpus except the tree's children, the
// sidebar is drawn (`drawSidebar`), then the children arrive in bursts of
// BURST rows and are touched again in bursts (as comes-with answers move
// them); each burst's publication, with the reactions it runs, is timed.
//   bun --conditions=@podium/source packages/client-graph/scripts/sidebar-burst-profile.ts <corpus-*.json> [tree=970] [burst=500]
import { runInAction } from 'mobx'
import { WORLD_NOW } from '../../sync/src/conformance/collection-server'
import { drawSidebar, loadCorpus } from '../src/large-answer.test.fixture'
import { MobxPool } from '../src/pool'
import type { RowRecord } from '../src/shared/source'

const [file, treeArg = '970', burstArg = '500'] = process.argv.slice(2)
if (file === undefined)
  throw new Error('usage: sidebar-burst-profile.ts <corpus.json> [tree] [burst]')
const corpus = await loadCorpus({ file, tree: Number(treeArg) })
const burst = Number(burstArg)
const children = new Set(corpus.treeIds.filter((id) => id !== corpus.root))
const issue = (row: Record<string, unknown>): RowRecord => ({
  kind: 'issue',
  id: String(row['id']),
  value: row as never,
})
const session = (row: Record<string, unknown>): RowRecord => ({
  kind: 'session',
  id: String(row['sessionId']),
  value: row as never,
})
const pool = new MobxPool({ selectedIssueId: null, coarseNow: WORLD_NOW })
pool.apply({
  type: 'replace',
  rows: [
    ...corpus.issues.filter((row) => !children.has(String(row['id']))).map(issue),
    ...corpus.sessions.map(session),
  ],
})
const sidebar = drawSidebar(pool, corpus.root)
const timed = (label: string, rows: RowRecord[]) => {
  const at = performance.now()
  runInAction(() => pool.apply({ type: 'update', rows }))
  return `${label}=${(performance.now() - at).toFixed(1)}`
}
const tree = corpus.issues.filter((row) => children.has(String(row['id'])))
const lines: string[] = []
for (let at = 0; at < tree.length; at += burst)
  lines.push(timed('arrive', tree.slice(at, at + burst).map(issue)))
for (let round = 1; round <= 3; round += 1)
  for (let at = 0; at < tree.length; at += burst)
    lines.push(
      timed(
        `touch${round}`,
        tree
          .slice(at, at + burst)
          .map((row) =>
            issue({ ...row, readAt: new Date(WORLD_NOW - round * 1000).toISOString() }),
          ),
      ),
    )
// One child moves: what a single change costs once the tree is in.
const one = tree[Math.floor(tree.length / 2)]!
lines.push(timed('one', [issue({ ...one, title: 'moved' })]))
// ONES=<n>: n more single changes, for a profile of what one change costs.
const ones: number[] = []
for (let n = 0; n < Number(process.env.ONES ?? 0); n += 1) {
  const at = performance.now()
  runInAction(() => pool.apply({ type: 'update', rows: [issue({ ...one, title: `moved ${n}` })] }))
  ones.push(performance.now() - at)
}
if (ones.length > 0)
  lines.push(`ones-median=${ones.sort((a, b) => a - b)[ones.length >> 1]!.toFixed(1)}`)
console.log(lines.join(' '))
console.log(sidebar.drawn())
sidebar.stop()
pool.dispose()
process.exit(0)
