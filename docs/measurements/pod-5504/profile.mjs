import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
const lab=process.env.IDLE_CPU_LAB ?? '/tmp/podium-idle-cpu-5504'
const req=createRequire(join(lab,'new/package.json'))
const mp=readdirSync(join(lab,'new/node_modules/.bun')).find(n=>n.startsWith('@jridgewell+trace-mapping@'))
const {TraceMap,originalPositionFor}=req(join(lab,'new/node_modules/.bun',mp,'node_modules/@jridgewell/trace-mapping'))
export function resolveProfile(profile,root) {
 const dist=join(root,'apps/web/dist/assets'), maps=new Map(), nodes=new Map(), parents=new Map()
 function resolve(f){
  const file=f.url?basename(new URL(f.url,'http://x').pathname):''
  if(!maps.has(file)) maps.set(file,existsSync(join(dist,file+'.map'))?new TraceMap(JSON.parse(readFileSync(join(dist,file+'.map'),'utf8'))):null)
  const tm=maps.get(file)
  if(!tm) return {function:f.functionName||'(anonymous)',sourceFunction:f.functionName||'(anonymous)',mapped:false}
  const pos=originalPositionFor(tm,{line:f.lineNumber+1,column:f.columnNumber})
  let name=pos.name
  const index=tm.sources.indexOf(pos.source)
  const lines=tm.sourcesContent?.[index]?.split('\n')
  const line=lines?.[pos.line-1]??''
  const suffix=line.slice(pos.column)
  const match=/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(suffix)||/^(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*[(:=]/.exec(suffix)||/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/.exec(line)||/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line)
  name=name||match?.[1]||f.functionName||'(anonymous)'
  // Source paths are local diagnostic metadata; never export them in summaries.
  const codeModule=pos.source?.replace(/^(\.\.\/)+/,'').replace(/^.*?\/node_modules\//,'node_modules/')
  return {function:name,sourceFunction:name,mapped:!!pos.source,codeModule,line:pos.line}
 }
 for(const node of profile.nodes){nodes.set(node.id,{...node,resolved:resolve(node.callFrame),self:0,inclusive:0});for(const child of node.children??[])parents.set(child,node.id)}
 let busy=0,total=0
 for(let i=0;i<(profile.samples?.length??0);i++){
  const ms=(profile.timeDeltas?.[i]??1000)/1000;total+=ms
  const node=nodes.get(profile.samples[i]);if(!node)continue
  node.self+=ms
  if(!['(idle)','(root)'].includes(node.callFrame.functionName))busy+=ms
  const seen=new Set()
  for(let id=node.id;id!=null;id=parents.get(id)){if(seen.has(id))break;seen.add(id);nodes.get(id).inclusive+=ms}
 }
 const combine=new Map()
 for(const n of nodes.values()){
  const key=n.resolved.function+'|'+n.resolved.codeModule+'|'+n.resolved.line
  const c=combine.get(key)??{...n.resolved,selfMs:0,inclusiveMs:0};c.selfMs+=n.self;c.inclusiveMs+=n.inclusive;combine.set(key,c)
 }
 const raw=[...combine.values()]
 const safe=rows=>rows.filter(x=>!['(idle)','(root)'].includes(x.function) && (x.selfMs>0||x.inclusiveMs>0)).slice(0,30).map(({function:fn,mapped,selfMs,inclusiveMs})=>({function:fn,mapped,selfMs:+selfMs.toFixed(2),inclusiveMs:+inclusiveMs.toFixed(2),busySharePct:+(selfMs/busy*100).toFixed(2)}))
 return {privateNodes:raw,summary:{sampledMs:+total.toFixed(2),busySampleMs:+busy.toFixed(2),sampleBusyPct:+(busy/total*100).toFixed(2),topSelf:safe(raw.sort((a,b)=>b.selfMs-a.selfMs)),topInclusive:safe(raw.sort((a,b)=>b.inclusiveMs-a.inclusiveMs))}}
}
