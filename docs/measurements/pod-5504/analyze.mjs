/** Offline summaries: never exports source paths, identifiers, DOM or payloads. */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfile } from './profile.mjs'
const lab=process.env.IDLE_CPU_LAB ?? '/tmp/podium-idle-cpu-5504'
const out=join(lab,'capture-20261008')
const destination=process.argv[2] ?? 'docs/measurements/POD-4286-idle-cpu-summary.json'
const summaries=[]
for(const filename of readdirSync(out).filter(n=>['baseline-summary.json','verified-summary.json','activity-proof-summary.json','quiet-css-summary.json','quiet-css-names-summary.json','quiet-projections-summary.json','warm-followup-summary.json','warm-profile-summary.json','activity-control-summary.json','previous-warm-profile-summary.json','final-paired-first-summary.json','final-paired-summary.json','previous-counters-summary.json','old-summary.json'].includes(n))){
 const content=JSON.parse(readFileSync(join(out,filename),'utf8'))
 for(const sample of content.summaries){
  if(sample.rawProfileAvailable===false && !sample.stamp.startsWith('paired-'))sample.stamp='paired-'+sample.stamp
  const root=join(lab,sample.label)
  if(!sample.traceDisabled && sample.rawProfileAvailable!==false){
   const trace=JSON.parse(readFileSync(join(out,sample.stamp+'.trace.json'),'utf8')).traceEvents
   sample.nativeFrameEvents={}
   for(const name of ['AnimationFrame::Presentation','PrePaint','BeginCommitCompositorFrame','FireAnimationFrame'])sample.nativeFrameEvents[name]={count:trace.filter(e=>e.name===name).length,perSecond:+(trace.filter(e=>e.name===name).length/sample.seconds).toFixed(3)}
  }
  if(!sample.metricsSeconds){sample.pilotMetricBusyPct=sample.mainThreadBusyPct;sample.mainThreadBusyPct=null}
  if(sample.rawProfileAvailable===false)for(const list of [sample.cpu.topSelf,sample.cpu.topInclusive]){for(let i=list.length-1;i>=0;i--)if(['(idle)','(root)'].includes(list[i].function))list.splice(i,1)}
  if(sample.profileDisabled||sample.rawProfileAvailable===false){summaries.push(sample);continue}
  const profile=JSON.parse(readFileSync(join(out,sample.stamp+'.cpuprofile'),'utf8'))
  const spans=new Map()
  function span(module,name){
   const key=module+':'+name
   if(!spans.has(key)){
    const lines=readFileSync(join(root,module),'utf8').split('\n')
    const start=lines.findIndex(line=>line.includes('function '+name+'('))
    const next=lines.slice(start+1).findIndex(line=>/^  (?:function|return \{)/.test(line))
    spans.set(key,[start+1,next<0?lines.length:start+2+next])
   }
   return spans.get(key)
  }
  const shell='packages/client-graph/src/shell-views.ts'
  const ranges={shellIssues:span(shell,'issues'),shellSessions:span(shell,'sessions')}
  function which(frame){
   const mod=frame.codeModule||''
   if(mod.endsWith('issue-board-source.ts')&&['indexKeys','indexedGrams'].includes(frame.function))return 'indexKeys / indexedGrams'
   if(mod===shell){for(const [name,[first,last]] of Object.entries(ranges))if(frame.line>=first && frame.line<last)return name}
   if(mod.endsWith('reader-queries.ts')&&frame.function==='activity')return 'ReaderQueries.activity'
   if(mod.endsWith('settings-views.ts'))return 'settings sessions / setup'
   if(mod.endsWith('chat-context.ts') && frame.function==='chatReferenceSessions')return 'chatReferenceSessions'
   if(mod.includes('mobx')&&frame.function==='eq')return 'eq'
   return null
  }
  // Each inclusive category is counted once per sample stack; categories overlap.
  const mapped=resolveProfile(profile,root,{classify:which})
  sample.cpu=mapped.summary
  sample.pathSelfShares=Object.fromEntries(Object.entries(mapped.pathTimes).map(([name,v])=>[name,{selfMs:+v.selfMs.toFixed(2),busySharePct:+(v.selfMs/sample.cpu.busySampleMs*100).toFixed(2),inclusiveMs:+v.inclusiveMs.toFixed(2),inclusiveBusySharePct:+(v.inclusiveMs/sample.cpu.busySampleMs*100).toFixed(2)}]))
  summaries.push(sample)
 }
}
// Export only known browser timeline event names; user timing marks can be dynamic.
const timelineNames=new Set(['RunTask','FunctionCall','EvaluateScript','EventDispatch','TimerFire','FireAnimationFrame','Layout','UpdateLayoutTree','PrePaint','Paint','PaintImage','CompositeLayers','RasterTask','BeginCommitCompositorFrame','AnimationFrame::Presentation'])
const safeFunction=name=>/^[$A-Za-z_][\w$]*(?:\.[$A-Za-z_][\w$]*)*$/.test(name)||['(anonymous)','(program)','(garbage collector)','(unattributed)'].includes(name)
for(const s of summaries){
 s.timeline=Object.fromEntries(Object.entries(s.timeline).filter(([name])=>timelineNames.has(name)))
 for(const timer of Object.values(s.timers))delete timer.topCallbacks
 for(const list of [s.cpu.topSelf,s.cpu.topInclusive])for(const row of list)if(!safeFunction(row.function))row.function='(unattributed)'
}
summaries.sort((a,b)=>a.startedAt.localeCompare(b.startedAt))
writeFileSync(destination,JSON.stringify({capturedOn:'ludovico',date:'2026-10-08',summaries},null,2)+'\n')
console.log(JSON.stringify({windows:summaries.length,destination:'aggregate summary'}))
