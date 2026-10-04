/** Temporary ablation bundle. Product sources stay at their recorded revision.
 * Every injected transform is archived beside the build for attribution. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { build } from '../node_modules/vite/dist/node/index.js'

if (hostname() !== 'flatblock') throw Error('Ablation builds run in the private flatblock checkout')
const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const out = resolve(arg('out', '.artifacts/cold-start/ablation-build'))
mkdirSync(out, {recursive:true})
const changes = []
const helper = `
const coldStartQuery = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
function coldStartFlag(key) {
  return coldStartQuery.get(key) === '1'
}
function coldStartMeasure(name, start, rows = 0) {
  if (!coldStartFlag('coldStartTrace')) return
  const list = window.__coldStartMetrics ??= []
  const end = performance.now()
  list.push({ name, start, end, ms:end-start, rows })
}
`
const flatMemo = `
const coldStartFlatMemo = new WeakMap()
function coldStartComposeIssue(projection, userState, gitState, repo, deps, blocked, sessionFacts) {
  const previous = coldStartFlatMemo.get(projection)
  if (previous && previous.userState === userState && previous.gitState === gitState &&
      previous.repo === repo && previous.deps === deps && previous.blocked === blocked &&
      previous.sessionFacts === sessionFacts) return previous.value
  const git = gitState && (({id:_id,...observation})=>observation)(gitState)
  const value = {...projection, readAt:userState?.readAt??null, tuckedAt:userState?.tuckedAt??null,
    pinned:userState?.pinned??false, gitState:git, repoPath:repo?.repoPath??'', deps, blocked, sessionFacts}
  coldStartFlatMemo.set(projection,{userState,gitState,repo,deps,blocked,sessionFacts,value})
  return value
}
`
const joinMemoSource = readFileSync(resolve(arg('join-memo','packages/client-core/src/join-memo.ts')),'utf8')
const writeBatchSource = readFileSync(resolve(arg('idb-helper','packages/sync/src/adapters/indexeddb/write-batch.ts')),'utf8')
const writeBatch = writeBatchSource.replace(/^import type[^\n]*\n/, '')
  .replace('        const end = Math.min(at + 256, ops.length)', `        const coldStartBatchBegan = performance.now(), coldStartBatchAt = at
        const end = Math.min(at + 256, ops.length)`)
  .replace('        if (at === ops.length)', `        coldStartMeasure('native-write-batch',coldStartBatchBegan,at-coldStartBatchAt)
        if (at === ops.length)`)
const quickMemo = joinMemoSource+`
const coldStartActualJoins = new JoinMemo()
function coldStartJoinMemo(root, keys) {
  if (coldStartFlag('coldStartQuickMemos')) {
    const owner=keys.shift()
    return coldStartActualJoins.cell(owner,keys)
  }
  let memo=root
  for (const key of keys) {
    let next=memo.next.get(key)
    if (!next) {next={next:new WeakMap()};memo.next.set(key,next)}
    memo=next
  }
  return memo
}
`

const plugin = {
  name:'cold-start-ablation', enforce:'pre',
  transform(original, id) {
    let code = original
    if (id.endsWith('/client-graph/src/shared/issue-input.ts')) {
      code = helper+flatMemo+quickMemo+code.replace('  if (!projection) return undefined', `  if (!projection) return undefined
  if (coldStartFlag('coldStartFlatMemo'))
    return coldStartComposeIssue(projection, userState, gitState, repo, deps, blocked, sessionFacts)`)
      code=code.replace(/  let memo = composed\n  for \(const key of (\[[\s\S]+?\])\) \{[\s\S]+?\n  \}\n  if \(memo.value/, '  const memo=coldStartJoinMemo(composed,$1)\n  if (memo.value')
    }
    if (id.endsWith('/client-core/src/session-values.ts')) {
      code=helper+quickMemo+code.replace(/  let memo = views\n  for \(const key of (\[[\s\S]+?\])\) \{[\s\S]+?\n  \}\n  if \(memo.value/, '  const memo=coldStartJoinMemo(views,$1)\n  if (memo.value')
    }
    if (id.endsWith('/client-graph/src/shared/cold-index.ts')) {
      code = helper+code.replace('    apply(event) {', `    apply(event) {
      const coldStartBegan = performance.now()`)
      code = code.replace('      readers.apply(event)', `      const coldStartReaderBegan = performance.now()
      readers.apply(coldStartFlag('coldStartNoIssueReaderIndex')
        ? {...event, rows:event.rows.filter(row=>row.kind !== 'issue')} : event)
      coldStartMeasure('reader-index:'+event.type, coldStartReaderBegan, event.rows.length)`)
      code = code.replace("      for (const [entity, id] of delta.flips) if (entity === 'session') activity.visibilityChanged(id)", `      for (const [entity, id] of delta.flips) if (entity === 'session') activity.visibilityChanged(id)
      coldStartMeasure('cold-index:'+event.type, coldStartBegan, event.rows.length)`)
    }
    if (id.endsWith('/client-graph/src/host/screens.ts')) {
      code = helper+code.replace('    if (!screen.attach) continue', `    if (!screen.attach) continue
    if (coldStartFlag('coldStartNoAttachedScreens') && screen.id !== 'sidebar') continue
    if (coldStartFlag('coldStartMinimalAttach') && !['sidebar','pane','shell'].includes(screen.id)) continue
    if (coldStartFlag('coldStartNoDormantAttach') && ['automations','notices','workflows','chatContext'].includes(screen.id)) continue
    const coldStartAttachBegan = performance.now()`)
      code = code.replace('      .then((stop) => {', `      .then((stop) => {
        coldStartMeasure('attach:'+screen.id, coldStartAttachBegan)`)
    }
    if (id.endsWith('/client-graph/src/reader-queries.ts')) {
      code=helper+code.replace('    for (const row of event.rows)\n', `    if (!(coldStartFlag('coldStartSkipReplaceQueries') && (event.type === 'replace' || fresh)))
    for (const row of event.rows)
`)
    }
    if (id.endsWith('/sync/src/adapters/indexeddb/store.ts')) {
      code=helper+writeBatch+code.replace("    const tx = this.db.transaction(scopeOf(draft), 'readwrite')", `    const coldStartCommitBegan = performance.now()
    const tx = this.db.transaction(scopeOf(draft), 'readwrite')`)
      code=code.replace('      for (const op of draft.ops) {\n        const store = tx.objectStore(op.store)', `      const coldStartQueueBegan = performance.now()
      if (coldStartFlag('coldStartChunkWrites')) await Promise.all([enqueueWrites(tx,draft.ops),completion])
      else for (const op of draft.ops) {
        const store = tx.objectStore(op.store)`)
      code=code.replace("        if (op.kind === 'put') store.put(op.value)", `        if (op.kind === 'put') {
          // Diagnostic only: retain the mirror and keys while removing payload
          // clone cost. This deliberately cannot certify durable startup.
          const value = coldStartFlag('coldStartNoEntityPayload') && op.store === ENTITY_STORE
            ? {...op.value,value:null} : op.value
          store.put(value)
        }`)
      code=code.replace('      }\n    } catch (error) {\n      if (error instanceof SyncCommitConflict)', `      }
      coldStartMeasure('native-enqueue',coldStartQueueBegan,draft.ops.length)
    } catch (error) {
      if (error instanceof SyncCommitConflict)`)
      code=code.replace('    await completion\n  }\n\n  /** Swap a committed draft', `    await completion
    coldStartMeasure('native-commit',coldStartCommitBegan,draft.ops.length)
  }

  /** Swap a committed draft`)
    }
    if (id.endsWith('/client-graph/src/create.ts')) {
      code = helper+code.replace('  const row = source.row?.bind(source)', `  const coldStartBuildBegan = performance.now()
  const row = source.row?.bind(source)`)
      code = code.replace('  const offRows = source.subscribe((event) => pool.apply(event))', `  coldStartMeasure('pool-build', coldStartBuildBegan)
  const offRows = source.subscribe((event) => {
    const coldStartApplyBegan = performance.now()
    pool.apply(coldStartFlag('coldStartResidentReplace') && event.type === 'replace'
      ? {...event,rows:event.rows.filter(row=>row.kind === 'worktree')} : event)
    coldStartMeasure('pool-apply:'+event.type, coldStartApplyBegan, event.rows.length)
  })`)
    }
    if (id.endsWith('/client-core/src/engine/runtime.ts')) {
      code = helper+code.replace('    void this.replica.hydrate().catch((error) => {', `    const coldStartHydrateBegan = performance.now()
    void (coldStartFlag('coldStartNoDiscardedHydrate') ? Promise.resolve() : this.replica.hydrate())
      .then(() => coldStartMeasure('discarded-hydrate', coldStartHydrateBegan))
      .catch((error) => {`)
    }
    if (id.endsWith('/client-graph/src/shared/row-source.ts')) {
      code = helper+code.replace('  function emit(event: RowSourceEvent): void {', `  function emit(event: RowSourceEvent): void {
    const coldStartEmitBegan = performance.now()`)
      code = code.replace('  }\n\n  function snapshot(kind: RowRecord', `    coldStartMeasure('row-source-emit:'+event.type, coldStartEmitBegan, event.rows.length)
  }

  function snapshot(kind: RowRecord`)
      code = code.replace('  function installSessionFacts(id: string, row: AnyRow | undefined): string[] {', '  function installSessionFacts(id: string, row: AnyRow | undefined, bulk = false): string[] {')
      code = code.replace('    const moved: string[] = []\n    for (const owner of owners)', `    return bulk ? [] : foldSessionFacts(owners)
  }

  function foldSessionFacts(owners: Iterable<string>): string[] {
    const moved: string[] = []
    for (const owner of owners)`)
      code = code.replace('      if (id !== null) installSessionFacts(id, row)\n    }\n  }', `      if (id !== null) installSessionFacts(id, row, coldStartFlag('coldStartBulkSessionFacts'))
    }
    if (coldStartFlag('coldStartBulkSessionFacts')) foldSessionFacts(sessionsByOwner.keys())
  }`)
      code = code.replace('    if (hadReplace) {\n      seedIssueJoins()', `    if (hadReplace) {
      const coldStartComposeBegan = performance.now()
      seedIssueJoins()`)
      code = code.replace('      emit(event)\n      return event', `      coldStartMeasure('row-source-compose:replace', coldStartComposeBegan, event.rows.length)
      emit(event)
      return event`)
    }
    if (id.endsWith('/client-graph/src/shared/reader-questions.ts')) {
      code = helper+code.replace('  function addTarget(key: string, id: string) {', `  function addTarget(key: string, id: string) {
    if (coldStartFlag('coldStartLazyTargets') && !targetPostings.has(key)) return`)
      code = code.replace("          const ids = targetPostings.get(`issue:path:${question.repoPath}`) ?? []", `          const targetKey = 'issue:path:'+question.repoPath
          if (coldStartFlag('coldStartLazyTargets') && !targetPostings.has(targetKey))
            targetPostings.set(targetKey,[...(buckets.get(targetKey)??[])].filter(id=>targetDetails.has(id)).sort(compareTargets))
          const ids = targetPostings.get(targetKey) ?? []`)
    }
    if (id.endsWith('/client-core/src/replica/kernel/facade.ts')) {
      code = helper+code.replace('  function buildMissingProjections(): void {', `  function buildMissingProjections(): void {
    const coldStartFacadeBegan = performance.now()`)
      code = code.replace('    issueRefs ??= new IssueRefIndex(records)', "    if (!coldStartFlag('coldStartLazyFacade')) issueRefs ??= new IssueRefIndex(records)")
      code = code.replace('      const rows = [...byId.values()]', `      if (coldStartFlag('coldStartLazyFacade')) {
        projected.set(kind,{rows:null,byId})
        dirtyRows.delete(kind)
        continue
      }
      const rows = [...byId.values()]`)
      code = code.replace('      dirtyRows.delete(kind)\n    }\n  }', `      dirtyRows.delete(kind)
    }
    coldStartMeasure('facade-build', coldStartFacadeBegan, records.length)
  }`)
      code = code.replace('keyOf(kind, a as never).localeCompare(keyOf(kind, b as never))', "coldStartFlag('coldStartLazyFacade') ? (keyOf(kind,a as never)<keyOf(kind,b as never)?-1:1) : keyOf(kind,a as never).localeCompare(keyOf(kind,b as never))")
      code = code.replaceAll('      if (issueRefs === undefined) buildMissingProjections()', `      if (issueRefs === undefined) {
        if (!coldStartFlag('coldStartLazyFacade')) buildMissingProjections()
        else {
          const index = new IssueRefIndex([])
          for (const row of project('repos')) index.repo(keyOf('repos',row),row)
          for (const row of project('issueProjections')) index.issue(keyOf('issueProjections',row),row)
          issueRefs=index
        }
      }`)
    }
    if (code===original) return null
    changes.push({id:id.replace(process.cwd()+'/', ''),sourceSha256:createHash('sha256').update(original).digest('hex'),transformed:code})
    return {code,map:null}
  },
}
await build({configFile:resolve('apps/web/vite.config.ts'),root:resolve('apps/web'),plugins:[plugin],build:{outDir:out,sourcemap:'hidden',emptyOutDir:true},logLevel:'warn'})
writeFileSync(resolve(out,'ablation-provenance.json'),JSON.stringify({
  sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  builderSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  joinMemoSha256:createHash('sha256').update(joinMemoSource).digest('hex'),
  writeBatchSha256:createHash('sha256').update(writeBatchSource).digest('hex'),
  changes,
},null,2))
console.log(`Ablation build ready: ${out}; ${changes.length} transformed modules`)
