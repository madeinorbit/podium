/** PREVIOUS counter-only variant: no feature flags or application behavior changed. */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const lab=resolve(process.env.IDLE_CPU_LAB??'/tmp/podium-idle-cpu-5504')
const root=join(lab,'previous-counters'),base='1082520'
function run(cmd,args,cwd=root){const p=spawnSync(cmd,args,{cwd,env:{...process.env,PATH:join(root,'.toolchain/bin')+':'+process.env.PATH},stdio:'inherit'});if(p.status!==0)throw new Error('Counter variant preparation failed')}
if(!existsSync(join(root,'.git')))run('git',['worktree','add','--detach',root,base],process.cwd())
if(!existsSync(join(root,'.toolchain')))cpSync(join(lab,'.toolchain'),join(root,'.toolchain'),{recursive:true})
if(!existsSync(join(root,'node_modules')))run('bun',['run','setup:worktree'])
writeFileSync(join(root,'packages/client-graph/src/idle-cpu-counters.ts'),`import { computed, Reaction } from 'mobx'
export function installIdleCounters(){
const g=globalThis as any
let counts: Record<string, number>={}
const proto=Object.getPrototypeOf(computed(()=>0))
for(const [object,method,key] of [[proto,'computeValue_','computedRuns'],[Reaction.prototype,'track','reactionTracks'],[Reaction.prototype,'runReaction_','reactionRuns']] as const){
 const original=(object as any)[method]
 if(typeof original!=='function')throw new Error('Counter boundary absent')
 ;(object as any)[method]=function(...args: unknown[]){counts[key]=(counts[key]??0)+1;return original.apply(this,args)}
}
g.__idleMobx={reset(){counts={}},read(){return {counts:{...counts},inclusiveMs:{}}}}
}
`)
const entry=join(root,'apps/web/src/lib/mobx-pilot.ts')
const original=spawnSync('git',['show',base+':apps/web/src/lib/mobx-pilot.ts'],{cwd:root,encoding:'utf8'}).stdout
if(!original)throw new Error('Counter entry absent')
writeFileSync(entry,"import { installIdleCounters } from '../../../../packages/client-graph/src/idle-cpu-counters'\ninstallIdleCounters()\n"+original)
console.log(JSON.stringify({event:'counter-variant',base}))
