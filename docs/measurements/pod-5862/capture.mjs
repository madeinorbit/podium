/** Private live-data capture; evidence exports only cardinalities and source names. */
import { chromium, webkit } from '@playwright/test'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'

if (hostname() !== 'ludovico') throw new Error('Live data stays on ludovico')
const args = new Map(process.argv.slice(2).map(a => { const [k,...v] = a.replace(/^--/,'').split('='); return [k,v.join('=')] }))
const out = resolve(args.get('out') ?? '/tmp/podium-memory-5862/baseline')
mkdirSync(out, { recursive: true, mode: 0o700 })
const url = args.get('url') ?? 'http://localhost:18787/'
const minutes = Number(args.get('minutes') ?? 10)
const mint = Bun.spawn(['podium','auth','mint-session','--print-only','--ttl','2h'], { stdout:'pipe', stderr:'ignore' })
const token = (await new Response(mint.stdout).text()).trim()
if (await mint.exited !== 0 || !token) throw new Error('Session mint failed')
function save(name, value) { const body = JSON.stringify(value,null,2); if (body.includes(token)) throw new Error('Credential in evidence'); writeFileSync(join(out,name),body,{mode:0o600}) }
function init() {
  const p = { commits:0, unmounts:0, errors:0, messages:0, bytes:0, freeze:false, paused:[],dataMessages:0,blockedMessages:0,sockets:0 }
  globalThis.__memoryProbe = p
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber:true, renderers:new Map(), inject(renderer) { this.renderers.set(this.renderers.size+1,renderer); return this.renderers.size }, onCommitFiberRoot() { p.commits++ }, onCommitFiberUnmount() { p.unmounts++ }, checkDCE() {} }
  addEventListener('error', () => p.errors++)
  addEventListener('unhandledrejection', () => p.errors++)
  const Ws = globalThis.WebSocket
  globalThis.WebSocket = class extends Ws { constructor(...a) { super(...a); p.sockets++; this.addEventListener('message',e => { p.messages++; p.bytes += typeof e.data==='string' ? e.data.length : e.data?.byteLength ?? e.data?.size ?? 0; const data=typeof e.data==='string'&&/^\s*\{\s*"type"\s*:\s*"(feedDelta|metadataDelta)"/.test(e.data);if(data)p.dataMessages++;if(p.freeze&&data){p.blockedMessages++;e.stopImmediatePropagation()} },true) } }
  localStorage.setItem('podium.panelMode',new URL(location.href).searchParams.get('captureMode')??'chat')
}
function findPool() {
  const element=document.getElementById('root')
  const key=element&&Object.keys(element).find(k=>k.startsWith('__reactContainer$'))
  if(!key)return false
  const start=element[key],fibers=[start.stateNode?.current??start],seen=new Set()
  while(fibers.length) {
    const f=fibers.pop();if(!f||seen.has(f))continue;seen.add(f)
    if(f.child)fibers.push(f.child);if(f.sibling)fibers.push(f.sibling)
    const objects=[{v:f.memoizedProps,d:0},{v:f.memoizedState,d:0}],checked=new Set()
    while(objects.length) {
      const {v,d}=objects.pop();if(!v||typeof v!=='object'||checked.has(v)||d>4)continue;checked.add(v)
      if(v.tables&&v.graph&&v.queries){globalThis.__memoryPool=new WeakRef(v);return true}
      for(const [k,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if(k==='next'&&d===0)objects.push({v:descriptor.value,d})
        else if(['pool','host','view','row','model','issue','session','worklist','memoizedState','value','current','deck','0','1','2','3'].includes(k))objects.push({v:descriptor.value,d:d+1})
      }
    }
  }
  return false
}
function findRuntime() {
  const element=document.getElementById('root')
  const key=element&&Object.keys(element).find(k=>k.startsWith('__reactContainer$'))
  const start=element?.[key],fibers=[start?.stateNode?.current??start],seen=new Set()
  while(fibers.length) {
    const f=fibers.pop();if(!f||seen.has(f))continue;seen.add(f)
    if(f.child)fibers.push(f.child);if(f.sibling)fibers.push(f.sibling)
    const objects=[{v:f.memoizedProps,d:0},{v:f.memoizedState,d:0}],checked=new Set()
    while(objects.length) {
      const {v,d}=objects.pop();if(!v||typeof v!=='object'||checked.has(v)||d>5)continue;checked.add(v)
      if(typeof v.ownConversations==='function'){globalThis.__memoryRuntime=new WeakRef(v);return true}
      for(const [k,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if(k==='next'&&d===0)objects.push({v:descriptor.value,d})
        else if(['pool','host','view','row','model','issue','session','worklist','memoizedState','value','current','deck','owner','runtime','conversation','core','engine','0','1','2','3'].includes(k))objects.push({v:descriptor.value,d:d+1})
      }
    }
  }
  return false
}
function processes(pid) {
  const found=[]
  function visit(id) { try { const stat=readFileSync(`/proc/${id}/status`,'utf8'); const cmd=readFileSync(`/proc/${id}/cmdline`,'utf8'); const kind=/--type=([^\0 ]+)/.exec(cmd)?.[1]??/^Name:\s+(.+)$/m.exec(stat)?.[1]??'browser'; const num=k=>Number(new RegExp(`^${k}:\\s+(\\d+)`,'m').exec(stat)?.[1]??0); const rollup=readFileSync(`/proc/${id}/smaps_rollup`,'utf8');const mem=k=>Number(new RegExp(`^${k}:\\s+(\\d+)`,'m').exec(rollup)?.[1]??0);found.push({pid:id,kind,rssKiB:num('VmRSS'),virtualKiB:num('VmSize'),swapKiB:num('VmSwap'),hwmKiB:num('VmHWM'),privateDirtyKiB:mem('Private_Dirty'),pssKiB:mem('Pss')}); const children=readFileSync(`/proc/${id}/task/${id}/children`,'utf8').trim(); if(children) for(const child of children.split(/\s+/))visit(Number(child)) } catch {} }
  visit(pid); return found
}
const engine=args.get('engine')??'chromium'
const type=engine==='webkit'?webkit:chromium
const server=await type.launchServer(engine==='webkit'?{headless:true,executablePath:'/home/mgw/.cache/ms-playwright/webkit-2287/pw_run.sh'}:{headless:true,executablePath:'/home/mgw/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--enable-precise-memory-info']})
const browser = await type.connect(server.wsEndpoint())
save('owned-pids.json',{collector:process.pid,browser:server.process().pid})
save('browser-endpoint.json',{endpoint:server.wsEndpoint()})
const context = await browser.newContext({ viewport:{width:1600,height:1000} })
await context.addCookies([{name:'podium_session',value:token,url}])
await context.addInitScript(init)
const page = await context.newPage()
const cdp=engine==='webkit'?null:await context.newCDPSession(page)
const samples=[]
const failures=[]
const consoleCounts={}
const consoleErrors=[]
page.on('console',message=>{const type=message.type();consoleCounts[type]=(consoleCounts[type]??0)+1;if(type==='error'&&consoleErrors.length<100){consoleErrors.push({at:new Date().toISOString(),text:message.text(),location:message.location()});save('console-errors-private.json',consoleErrors)}})
page.on('pageerror', e=>{ failures.push({name:e.name,message:e.message,stack:e.stack}); save('errors-private.json',failures); console.log(JSON.stringify({event:'page-error',count:failures.length})) })
async function sample(minute, phase) {
  await page.evaluate(findPool)
  await page.evaluate(findRuntime)
  await cdp?.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(150)
  await cdp?.send('HeapProfiler.collectGarbage')
  const heap=await cdp?.send('Runtime.getHeapUsage')??null
  const dom=await cdp?.send('Memory.getDOMCounters')??null
  const metrics=cdp?Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value])):null
  const browserStats=await page.evaluate(async () => {
    const p=globalThis.__memoryProbe
    const animations={}
    for(const a of document.getAnimations()) { const key=a.animationName??a.constructor.name; const v=animations[key]??={total:0,running:0,keyframes:0}; v.total++; v.running+=a.playState==='running'?1:0; v.keyframes+=a.effect?.getKeyframes().length??0 }
    const usage=await navigator.storage?.estimate?.().catch(()=>null)
    const databases=await indexedDB.databases().catch(()=>[])
    const stores=[]
    for(const info of databases) { if(!info.name)continue; await new Promise(resolve => { const request=indexedDB.open(info.name); request.onerror=()=>resolve(); request.onsuccess=async()=>{ const db=request.result; try { for(const name of db.objectStoreNames) { const tx=db.transaction(name,'readonly'); const count=await new Promise(r=>{ const q=tx.objectStore(name).count(); q.onsuccess=()=>r(q.result); q.onerror=()=>r(null) }); stores.push({name,count}) } } finally { db.close(); resolve() } } }) }
    const counts={},pool=globalThis.__memoryPool?.deref(),seen=new Set()
    function walk(v,path,depth){if(!v||typeof v!=='object'||seen.has(v)||depth>3)return;seen.add(v);if(typeof v.size==='number'){counts[path]=v.size;return}if(Array.isArray(v)){counts[path]=v.length;return}for(const [k,d] of Object.entries(Object.getOwnPropertyDescriptors(v)))if(d.value&&typeof d.value==='object')walk(d.value,path+'.'+k,depth+1)}
    if(pool){walk(pool,'pool',0);for(const [key,view] of pool.sources.views)walk(view,'view.'+key,0)}
    const cache=globalThis.__memoryRuntime?.deref()?.conversationCache
    const transcriptOwners=[]
    for(const {conversation:c,refs} of cache?.entries.values()??[]) {
      const graph=c.graph,index=graph?.searchIndex
      transcriptOwners.push({refs,items:c.transcript?.ids?.length,blocks:graph?.blockIds?.length,
        index:index?{texts:index.texts.size,postings:index.postings.size,memberships:[...index.postings.values()].reduce((n,v)=>n+v.size,0),gramsById:index.gramsById.size,textChars:[...index.texts.values()].reduce((n,v)=>n+v.length,0)}:null})
    }
    return {commits:p.commits,unmounts:p.unmounts,errors:p.errors,messages:p.messages,dataMessages:p.dataMessages,blockedMessages:p.blockedMessages,sockets:p.sockets,bytes:p.bytes,elements:document.querySelectorAll('*').length,issueRows:document.querySelectorAll('[data-issue-row]').length,animations,storageBytes:usage?.usage??null,storageDetails:usage?.usageDetails??null,idbDatabaseCount:databases.length,idbStores:stores,serviceWorkerControlled:!!navigator.serviceWorker?.controller,resources:performance.getEntriesByType('resource').length,canvas:document.querySelectorAll('canvas').length,xterm:document.querySelectorAll('.xterm').length,workScroll:!!document.querySelector('[data-testid=work-scroll]'),faultText:/Something went wrong|component crashed|This panel crashed/.test(document.body.innerText),marks:performance.getEntriesByType('mark').length,measures:performance.getEntriesByType('measure').length,smil:document.querySelectorAll('animate,animateTransform,animateMotion').length,ownerCounts:counts,conversationCache:cache?{entries:cache.entries.size,warm:cache.warm.size,owners:transcriptOwners}:null}
  })
  const value={minute,phase,at:new Date().toISOString(),heap,dom,metrics,...browserStats,consoleCounts:{...consoleCounts},processes:processes(server.process().pid)}
  samples.push(value); save('samples.json',samples); console.log(JSON.stringify(value))
  if(args.has('sample-allocations')&&cdp)save('allocations-'+minute+'.json',await cdp.send('HeapProfiler.getSamplingProfile'))
  if(!value.workScroll){save('interruption-private.json',{text:await page.locator('body').innerText()});throw new Error('Capture interrupted: workspace was unmounted')}
}
async function snapshot(name) {
  const gzip=createGzip(), dest=createWriteStream(join(out,name+'.heapsnapshot.gz'),{mode:0o600})
  const done=pipeline(gzip,dest)
  const chunk=e=>gzip.write(e.chunk)
  cdp.on('HeapProfiler.addHeapSnapshotChunk',chunk)
  try { await cdp.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false}); gzip.end(); await done } finally { cdp.off('HeapProfiler.addHeapSnapshotChunk',chunk) }
  console.log(JSON.stringify({event:'snapshot',name}))
}
try {
  await cdp?.send('Performance.enable')
  await page.goto(url+'?e2e=1&captureMode='+encodeURIComponent(args.get('panel-mode')??'chat'),{waitUntil:'domcontentloaded',timeout:30000})
  console.log(JSON.stringify({event:'loaded', ...(await page.evaluate(()=>({elements:document.querySelectorAll('*').length,rows:document.querySelectorAll('[data-issue-row]').length,password:!!document.querySelector('input[type=password]'),workScroll:!!document.querySelector('[data-testid=work-scroll]'),errors:globalThis.__memoryProbe.errors})))}))
  await page.waitForFunction(()=>!!document.querySelector('[data-testid=work-scroll]'),undefined,{timeout:180000}).catch(async e=>{console.log(JSON.stringify({event:'startup-failure',...(await page.evaluate(async()=>({auth:await fetch('/auth/status').then(r=>r.json()).then(v=>({authed:v.authed,needsAuth:v.needsAuth,readiness:v.readiness?.state})),elements:document.querySelectorAll('*').length})))}));throw e})
  await page.waitForTimeout(10000)
  await page.evaluate(findPool)
  if(args.has('self')) {
    const selected=await page.evaluate(()=>{
      const pool=globalThis.__memoryPool?.deref()
      const issue=[...(pool?.tables.issue??[])].find(([,r])=>r.seq===5862)?.[0]
      const seat=[...(pool?.tables.session??[])].find(([,r])=>r.issueId===issue&&!r.exitedAt&&!r.archived)?.[0]
      const el=document.querySelector('[data-issue-row]'),key=el&&Object.keys(el).find(k=>k.startsWith('__reactFiber$'))
      for(let f=el?.[key];f;f=f.return)if(issue&&seat&&typeof f.memoizedProps?.onSelectPanelForIssue==='function'){f.memoizedProps.onSelectPanelForIssue({id:issue},seat);return {selected:true}}
      return {selected:false,issue:!!issue,seat:!!seat}
    })
    console.log(JSON.stringify({event:'streaming-self-selection',...selected}));if(!selected.selected)throw new Error('Streaming session could not be selected');await page.waitForTimeout(10000)
  }
  if(args.has('pilot')) {
    const selected=await page.evaluate(()=>{const pool=globalThis.__memoryPool?.deref();const id=[...(pool?.tables.issue??[])].find(([,row])=>row.seq===4286)?.[0];const el=document.querySelector('[data-issue-row]');const key=el&&Object.keys(el).find(k=>k.startsWith('__reactFiber$'));for(let f=el?.[key];f;f=f.return)if(id&&typeof f.memoizedProps?.onSelectIssue==='function'){f.memoizedProps.onSelectIssue({id});return true}return false})
    console.log(JSON.stringify({event:'pilot-selection',selected}));await page.waitForTimeout(10000)
  }
  if(args.get('panel-mode')==='native') { const button=page.locator('[data-testid=mode-native]:visible').first();if(await button.count())await button.click({timeout:10000}) }
  if(args.has('sample-allocations')&&cdp)await cdp.send('HeapProfiler.startSampling',{samplingInterval:65536})
  const v=await fetch('http://localhost:18787/version').then(r=>r.json())
  const identity={backend:v.appVersion,backendDigest:v.sourceDigest,wireSchemaDigest:v.wireSchemaDigest}
  if(args.has('dist'))identity.bundleManifest=(()=>{const m=JSON.parse(readFileSync(join(args.get('dist'),'podium-build-manifest.json'),'utf8'));return {sourceCommit:m.sourceCommit,buildStamp:m.buildStamp,fileCount:m.fileCount}})(); save('provenance.json',identity); console.log(JSON.stringify({event:'hydrated',identity}))
  await sample(0,'idle')
  if(args.has('start-snapshot')&&cdp)await snapshot('start')
  const started=Date.now()
  for(let minute=1;minute<=minutes;minute++) {
    const switches=Number(args.get('switches')??0)
    for(let turn=0;turn<switches;turn++) {
      const rows=page.locator('[data-issue-row]');const count=await rows.count();if(!count)break
      const row=rows.nth((minute*switches+turn)%count)
      const before=await page.locator('[data-issue-row][data-selected=true]').getAttribute('data-issue-row').catch(()=>null)
      try{await row.click({timeout:10000});await page.waitForTimeout(2000);const after=await page.locator('[data-issue-row][data-selected=true]').getAttribute('data-issue-row').catch(()=>null);console.log(JSON.stringify({event:'issue-switch',minute,changed:after!==before}));if(args.get('panel-mode')==='native'){const button=page.locator('[data-testid=mode-native]:visible').first();if(await button.count())await button.click({timeout:10000})}}catch{console.log(JSON.stringify({event:'switch-failed',minute}))}
    }
    if(minute===Number(args.get('warm-at')??2)) {
      const ids=await page.locator('[data-issue-row]').evaluateAll(es=>es.filter(e=>e.getAttribute('data-selected')!=='true').slice(0,2).map(e=>e.getAttribute('data-issue-row')))
      for(const id of ids) { try { await page.locator(`[data-issue-row=${JSON.stringify(id)}]`).first().click({timeout:20000}); await page.waitForTimeout(5000) } catch { console.log(JSON.stringify({event:'switch-failed',minute})) } }
      const tab=page.locator('[data-tab-drag-id]:not([title]):not(.native-tab-active):visible').first().locator('button[data-pressable]').first()
      if(await tab.count())try { await tab.click({timeout:20000}) } catch {}
      console.log(JSON.stringify({event:'warmed',minute}))
      if(args.get('panel-mode')==='native'){const button=page.locator('[data-testid=mode-native]:visible').first();if(await button.count())await button.click({timeout:10000})}
    }
    if(minute===Number(args.get('freeze-at')??-1)) { await page.evaluate(()=>globalThis.__memoryProbe.freeze=true); console.log(JSON.stringify({event:'freeze-feed',minute})) }
    if(minute===Number(args.get('pause-css-at')??-1)) { await page.evaluate(()=>{ for(const a of document.getAnimations())a.pause() }); console.log(JSON.stringify({event:'pause-css',minute})) }
    const left=started+minute*60000-Date.now()
    if(left>0)await page.waitForTimeout(left)
    await sample(minute,minute>=Number(args.get('freeze-at')??Infinity)?'feed-frozen':minute>=Number(args.get('pause-css-at')??Infinity)?'css-paused':minute>=Number(args.get('warm-at')??2)?'warm-idle':'idle')
  }
  if(args.has('snapshots')&&cdp)await snapshot('end')
} catch(error) { save('capture-failure-private.json',{name:error.name,message:error.message,stack:error.stack});console.log(JSON.stringify({event:'capture-failed',name:error.name,message:error.message}));process.exitCode=1 }
finally { await context.close(); await browser.close(); await server.close() }
