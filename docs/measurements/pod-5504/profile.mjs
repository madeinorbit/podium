import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
const lab=process.env.IDLE_CPU_LAB ?? '/tmp/podium-idle-cpu-5504'
const req=createRequire(join(lab,'new/package.json'))
const mp=readdirSync(join(lab,'new/node_modules/.bun')).find(n=>n.startsWith('@jridgewell+trace-mapping@'))
const {TraceMap,originalPositionFor}=req(join(lab,'new/node_modules/.bun',mp,'node_modules/@jridgewell/trace-mapping'))
const mapCaches=new Map(), sourceLines=new WeakMap()
export function resolveProfile(profile,root,options={}) {
 const dist=join(root,'apps/web/dist/assets')
 if(!mapCaches.has(dist))mapCaches.set(dist,new Map())
 const maps=mapCaches.get(dist), nodes=new Map(), parents=new Map()
 function resolve(f){
  const file=f.url?basename(new URL(f.url,'http://x').pathname):''
  if(!maps.has(file)) maps.set(file,existsSync(join(dist,file+'.map'))?new TraceMap(JSON.parse(readFileSync(join(dist,file+'.map'),'utf8'))):null)
  const tm=maps.get(file)
  if(!tm) return {function:f.functionName||'(anonymous)',sourceFunction:f.functionName||'(anonymous)',mapped:false}
  const pos=originalPositionFor(tm,{line:f.lineNumber+1,column:f.columnNumber})
  let name=pos.name
  const index=tm.sources.indexOf(pos.source)
  if(!sourceLines.has(tm))sourceLines.set(tm,new Map())
  const cachedLines=sourceLines.get(tm)
  if(!cachedLines.has(index))cachedLines.set(index,tm.sourcesContent?.[index]?.split('\n'))
  const lines=cachedLines.get(index)
  const line=lines?.[pos.line-1]??''
  const suffix=line.slice(pos.column)
  const match=/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(suffix)||/^(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*[(:=]/.exec(suffix)||/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/.exec(line)||/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line)
  name=name||match?.[1]||f.functionName||'(anonymous)'
  if(['function','return','const','let','var','async','default','export'].includes(name))name='(anonymous)'
  // Source paths are local diagnostic metadata; never export them in summaries.
  const codeModule=pos.source?.replace(/^(\.\.\/)+/,'').replace(/^.*?\/node_modules\//,'node_modules/')
  return {function:name,sourceFunction:name,mapped:!!pos.source,codeModule,line:pos.line}
 }
 for(const node of profile.nodes){nodes.set(node.id,{...node,resolved:resolve(node.callFrame),self:0,inclusive:0});for(const child of node.children??[])parents.set(child,node.id)}
 const pathTimes=new Map(), functionInclusive=new Map()
 const functionKey=n=>n.resolved.function+'|'+n.resolved.codeModule+'|'+n.resolved.line
 for(const n of nodes.values())n.category=options.classify?.(n.resolved)??null
 let busy=0,total=0
 for(let i=0;i<(profile.samples?.length??0);i++){
  const ms=(profile.timeDeltas?.[i]??1000)/1000;total+=ms
  const node=nodes.get(profile.samples[i]);if(!node)continue
  node.self+=ms
  if(!['(idle)','(root)'].includes(node.callFrame.functionName))busy+=ms
  const seen=new Set(), categories=new Set(), stackFunctions=new Set()
  for(let id=node.id;id!=null;id=parents.get(id)){if(seen.has(id))break;seen.add(id);const frame=nodes.get(id);frame.inclusive+=ms;stackFunctions.add(functionKey(frame));if(frame.category)categories.add(frame.category)}
  for(const fn of stackFunctions)functionInclusive.set(fn,(functionInclusive.get(fn)??0)+ms)
  for(const category of categories){const t=pathTimes.get(category)??{selfMs:0,inclusiveMs:0};t.inclusiveMs+=ms;if(node.category===category)t.selfMs+=ms;pathTimes.set(category,t)}
 }
 const combine=new Map()
 for(const n of nodes.values()){
  const key=functionKey(n)
  const c=combine.get(key)??{...n.resolved,selfMs:0,inclusiveMs:0};c.selfMs+=n.self;c.inclusiveMs=functionInclusive.get(key)??0;combine.set(key,c)
 }
 const raw=[...combine.values()]
 const safe=rows=>rows.filter(x=>!['(idle)','(root)'].includes(x.function) && (x.selfMs>0||x.inclusiveMs>0)).slice(0,30).map(({function:fn,mapped,selfMs,inclusiveMs})=>({function:fn,mapped,selfMs:+selfMs.toFixed(2),inclusiveMs:+inclusiveMs.toFixed(2),busySharePct:+(selfMs/busy*100).toFixed(2)}))
 return {privateNodes:raw,pathTimes:Object.fromEntries(pathTimes),summary:{sampledMs:+total.toFixed(2),busySampleMs:+busy.toFixed(2),sampleBusyPct:total?+(busy/total*100).toFixed(2):null,topSelf:safe(raw.sort((a,b)=>b.selfMs-a.selfMs)),topInclusive:safe(raw.sort((a,b)=>b.inclusiveMs-a.inclusiveMs))}}
}
