/** Creates a disposable production variant, never changes the issue's product code. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
const lab=resolve(process.env.IDLE_CPU_LAB ?? '/tmp/podium-idle-cpu-5504')
const label=process.argv[2]??'instrumented'
const base=process.argv[3]??'44809b1850'
const root=join(lab,label)
function run(cmd,args){const p=spawnSync(cmd,args,{cwd:root,env:{...process.env,PATH:join(root,'.toolchain/bin')+':'+process.env.PATH},stdio:'inherit'});if(p.status!==0)throw new Error('Preparation failed')}
if(!existsSync(join(root,'.git'))){const p=spawnSync('git',['worktree','add','--detach',root,base],{stdio:'inherit'});if(p.status!==0)throw new Error('Checkout failed')}
if(!existsSync(join(root,'.toolchain')))cpSync(join(lab,'.toolchain'),join(root,'.toolchain'),{recursive:true})
if(!existsSync(join(root,'node_modules')))run('bun',['run','setup:worktree'])
function edit(rel,modify){const p=join(root,rel);const original=spawnSync('git',['show',base+':'+rel],{cwd:root,encoding:'utf8'}).stdout;if(!original)throw new Error('Original source unavailable');const next=modify(original);if(next===original)throw new Error('Missing instrumentation seam '+rel);writeFileSync(p,next)}
const graph='packages/client-graph/src/'
writeFileSync(join(root,graph,'idle-cpu-measurement.ts'),`import { computed, Reaction, observable, runInAction } from 'mobx'
const g = globalThis as any
let counts: Record<string, number> = {}
let times: Record<string, number> = {}
const answers = new Map<string, unknown>()
const disabled = observable.box('')
export function idleCount(key: string, amount = 1) { counts[key] = (counts[key] ?? 0) + amount }
export function idleRead<T>(key: string, body: () => T, cacheKey = key): T {
  const selected = disabled.get()
  if ((selected.split('+').includes(key) || selected === 'all') && answers.has(cacheKey)) return answers.get(cacheKey) as T
  const start = performance.now()
  idleCount(key)
  try { const value = body(); answers.set(cacheKey, value); return value }
  finally { times[key] = (times[key] ?? 0) + performance.now() - start }
}
export function idleFreezer(body: () => void) { (g.__idleFreezers ??= []).push(body) }
const computedProto = Object.getPrototypeOf(computed(() => 0))
for (const [proto, method, key] of [[computedProto, 'computeValue_', 'computedRuns'], [Reaction.prototype, 'track', 'reactionTracks'], [Reaction.prototype, 'runReaction_', 'reactionRuns']] as const) {
  const original = (proto as any)[method]
  if (typeof original !== 'function') throw new Error('Measurement boundary absent')
  ;(proto as any)[method] = function (...args: unknown[]) { idleCount(key); return original.apply(this, args) }
}
g.__idleMobx = { reset() { counts = {}; times = {} }, read() { return { counts: { ...counts }, inclusiveMs: { ...times } } } }
g.__idleAblations = { set(key: string) { runInAction(() => disabled.set(key)) } }
`)
function memoWrap(s,prefix){
 const needle='  function memo<T>(key: string, read: () => T): T {'
 const start=s.indexOf(needle)
 if(start<0)throw new Error('memo seam absent')
 let cursor=start+needle.length,depth=1
 while(depth && cursor<s.length){if(s[cursor]==='{')depth++;else if(s[cursor]==='}')depth--;cursor++}
 const body=s.slice(start+needle.length,cursor-1).replaceAll('computed(read,', 'computed(measuredRead,').replaceAll('return read()', 'return measuredRead()')
 return "import { idleRead } from './idle-cpu-measurement'\n"+s.slice(0,start)+needle+`\n    const measuredRead = key.includes(':') ? read : () => idleRead('${prefix}.' + key, read)`+body+'\n  }'+s.slice(cursor)
}
edit(graph+'shell-views.ts',s=>memoWrap(s,'shell'))
edit(graph+'settings-views.ts',s=>memoWrap(s,'settings'))
edit(graph+'chat-context.ts',s=>"import { idleRead } from './idle-cpu-measurement'\n"+s.replace('mentions: () => chatMentionIssues(pool, counts),',"mentions: () => idleRead('chat.mentions', () => chatMentionIssues(pool, counts)),").replace('sessions: () => chatReferenceSessions(pool, counts),',"sessions: () => idleRead('chat.references', () => chatReferenceSessions(pool, counts)),"))
edit(graph+'issue-board-source.ts',s=>"import { idleCount, idleRead } from './idle-cpu-measurement'\n"+s.replace('  function indexKeys(row: IssueViewModel): Set<string> {','  function indexKeys(row: IssueViewModel): Set<string> {\n    idleCount(\'indexKeys\')').replace('      () => {\n        const row = facts(id)\n        return row && row !== LOADING ? indexKeys(row) : new Set<string>()\n      },', "      () => idleRead('index', () => {\n        const row = facts(id)\n        return row && row !== LOADING ? indexKeys(row) : new Set<string>()\n      }, 'index:' + id),"))
edit(graph+'runtime-pool.ts',s=>"import { idleCount } from './idle-cpu-measurement'\n"+s.replace('  const state = projectionState(pool, read, options)','  idleCount(\'projectionCreated\')\n  const state = projectionState(pool, read, options)').replace('    subscribe(wake: () => void): () => void {','    subscribe(wake: () => void): () => void {\n      idleCount(\'projectionSubscriptions\')').replace('        state.listeners.delete(listener)','        idleCount(\'projectionUnsubscriptions\')\n        state.listeners.delete(listener)').replace('  if (!state.dirty) return','  if (!state.dirty) return\n  idleCount(\'projectionRefresh\')').replace('  const owned = new Set(options.owns ?? [])','  idleCount(\'poolCreated\')\n  const owned = new Set(options.owns ?? [])'))
edit(graph+'pool.ts',s=>"import { idleCount } from './idle-cpu-measurement'\n"+s.replace('  apply(event: RowSourceEvent): void {','  apply(event: RowSourceEvent): void {\n    idleCount(\'poolApplications\')\n    idleCount(\'poolRowsDelivered\', event.rows.length)\n    for (const row of event.rows) idleCount(\'poolRows_\' + row.kind)'))
console.log(JSON.stringify({event:'instrumented',label,base}))

edit(graph+'reader-queries.ts',s=>{
 const needle='  activity(question: SessionActivityQuestion): number {'
 const start=s.indexOf(needle)
 if(start<0)throw new Error('Activity seam absent')
 let cursor=start+needle.length,depth=1
 while(depth&&cursor<s.length){if(s[cursor]==='{')depth++;else if(s[cursor]==='}')depth--;cursor++}
 const body=s.slice(start+needle.length,cursor-1).replace("    const resident = residentIds(this.pool, 'session')", "    const resident = residentIds(this.pool, 'session')\n    idleCount('activityResidentVisits', resident.length)\n    idleCount('activity_' + question.kind)")
 return "import { idleCount, idleRead } from './idle-cpu-measurement'\n"+s.slice(0,start)+needle+"\n    return idleRead('reader.activity', () => {"+body+"\n    }, 'reader.activity:' + JSON.stringify(question))\n  }"+s.slice(cursor)
})
