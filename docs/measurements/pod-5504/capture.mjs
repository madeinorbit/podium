/** Live-data collector. All credentials and DOM identifiers stay in memory.
 * Run from the issue checkout with its copied, pinned Bun. No app fixes ship.
 * Raw profiles/traces stay in the private local lab; exported summaries contain
 * only counts, timings and source function names. */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { resolveProfile } from './profile.mjs'
const args = new Map(process.argv.slice(2).map(a => {const [k,...v]=a.replace(/^--/,'').split('=');return [k,v.join('=')]}))
const lab = process.env.IDLE_CPU_LAB ?? '/tmp/podium-idle-cpu-5504'
const out = join(lab, 'capture-20261008')
mkdirSync(out, { recursive: true, mode: 0o700 })
const requireLab = createRequire(join(lab,'new/package.json'))
const { chromium } = requireLab('@playwright/test')
const webRequire = createRequire(join(lab,'new/apps/web/package.json'))
const vitePath = webRequire.resolve('vite')
const { preview } = await import(vitePath)
if(hostname() !== 'ludovico') throw new Error('Live data must remain on ludovico')
const mint = Bun.spawn(['podium','auth','mint-session','--print-only','--ttl','2h'],{stdout:'pipe',stderr:'ignore'})
const token = (await new Response(mint.stdout).text()).trim()
if(await mint.exited !== 0 || !token) throw new Error('Session mint failed')
function save(name,data){const bytes=JSON.stringify(data,null,2);if(bytes.includes(token))throw new Error('Credential found in evidence');writeFileSync(join(out,name),bytes,{mode:0o600})}
function verify(root) {
 const manifest = JSON.parse(readFileSync(join(root,'apps/web/dist/podium-build-manifest.json'),'utf8'))
 let checked=0
 for(const [file,digest] of Object.entries(manifest.files)) {
  const actual=createHash('sha256').update(readFileSync(join(root,'apps/web/dist',file))).digest('hex')
  if(actual!==digest) throw new Error('Dist inventory mismatch')
  checked++
 }
 return {source:manifest.sourceCommit,filesChecked:checked}
}
function initProbe() {
 const g=globalThis
 const p={commits:0,errors:0,longTasks:[],timers:{},ws:{messages:0,bytes:0},rafFrames:0}
 const kinds=['setTimeout','setInterval','requestAnimationFrame']
 for(const kind of kinds){
  const original=g[kind].bind(g)
  p.timers[kind]={created:0,fires:0,ms:0,byName:{}}
  g[kind]=function(callback,...args){
   const stats=p.timers[kind];stats.created++
   if(typeof callback!=='function') return original(callback,...args)
   const key=callback.name || '(anonymous)'
   return original(function(...values){
    const start=performance.now();stats.fires++
    if(kind==='requestAnimationFrame') p.rafFrames++
    try{return callback.apply(this,values)} finally {
     const duration=performance.now()-start;stats.ms+=duration
     const body=stats.byName[key]??={fires:0,ms:0};body.fires++;body.ms+=duration
    }
   },...args)
  }
 }
 g.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(renderer){this.renderers.set(this.renderers.size+1,renderer);return this.renderers.size},onCommitFiberRoot(){p.commits++},onCommitFiberUnmount(){},checkDCE(){}}
 new PerformanceObserver(list=>{for(const e of list.getEntries()) p.longTasks.push({start:e.startTime,ms:e.duration})}).observe({type:'longtask'})
 addEventListener('error',()=>p.errors++)
 addEventListener('unhandledrejection',()=>p.errors++)
 const Ws=g.WebSocket
 g.WebSocket=class extends Ws {constructor(...args){super(...args);this.addEventListener('message',e=>{p.ws.messages++;p.ws.bytes+=typeof e.data==='string'?e.data.length:e.data?.byteLength??e.data?.size??0})}}
 p.reset=()=>{p.commits=0;p.errors=0;p.longTasks=[];p.rafFrames=0;for(const s of Object.values(p.timers)){s.created=0;s.fires=0;s.ms=0;s.byName={}};p.ws={messages:0,bytes:0};g.__idleMobx?.reset?.()}
 p.read=()=>({commits:p.commits,errors:p.errors,longTasks:p.longTasks,timers:p.timers,ws:p.ws,rafFrames:p.rafFrames,mobx:g.__idleMobx?.read?.()??null,store:g.__podiumStoreStats?.snapshot ? (()=>{const s=g.__podiumStoreStats.snapshot();const keys={};for(const p of s.publishes)for(const k of p.changedKeys)keys[k]=(keys[k]??0)+1;return {publishes:s.runtimes.reduce((n,r)=>n+r.publishes,0),subscriberWakes:s.runtimes.reduce((n,r)=>n+r.subscriberWakes,0),dropped:s.dropped,changedKeyCounts:keys}})():null,pool:g.__podiumSidebarPerf?.read ? (()=>{const q=g.__podiumSidebarPerf.read();return {pool:q.pool,work:q.work,idle:q.idle,overflow:q.overflow,windowMs:q.windowMs}})():null})
 g.__idleProbe=p
 localStorage.setItem('podium.panelMode','chat')
}
const browserServer=await chromium.launchServer({headless:true,executablePath:'/home/mgw/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage']})
const browser=await chromium.connect(browserServer.wsEndpoint())
save('owned-pids.json',{collector:process.pid,chromium:browserServer.process().pid})
const servers=new Map(),summaries=[]
try {
 console.log(JSON.stringify({event:'start',at:new Date().toISOString(),chromium:browser.version()}))
 const labels=(args.get('labels')||'new,previous,new,previous').split(',')
 const interventions=(args.get('interventions')||'').split(',')
 const duration=Number(args.get('seconds')||60)*1000
 for(let turn=0;turn<labels.length;turn++){
  const label=labels[turn],root=join(lab,label)
  if(!servers.has(label)){
   const provenance=verify(root)
   const port=label==='new'?55704:label==='previous'?55705:55706+turn
   const server=await preview({root:join(root,'apps/web'),configFile:join(root,'apps/web/vite.config.ts'),preview:{host:'127.0.0.1',port,strictPort:true}})
   servers.set(label,{server,port,provenance})
  }
  const {port,provenance}=servers.get(label)
  const intervention=interventions[turn]||args.get('ablate')||'baseline'
  const context=await browser.newContext({viewport:{width:1600,height:1000},serviceWorkers:'block'})
  await context.addCookies([{name:'podium_session',value:token,url:`http://localhost:${port}`}])
  await context.addInitScript(initProbe)
  const page=await context.newPage()
  const client=await context.newCDPSession(page)
  await client.send('Performance.enable')
  page.on('requestfailed',r=>{const u=new URL(r.url());if(u.pathname==='/sync/bootstrap')console.log(JSON.stringify({event:'bootstrap-failed',label,error:r.failure()?.errorText}))})
  page.on('response',r=>{if(r.status()>=400){const u=new URL(r.url());console.log(JSON.stringify({event:'http-status',label,status:r.status(),endpoint:u.pathname.startsWith('/sync')?'sync':u.pathname.startsWith('/trpc')?'trpc':'other'}))}})
  await page.goto(`http://localhost:${port}/?e2e=1&switchTrace=1`,{waitUntil:'domcontentloaded',timeout:30000})
  await page.waitForFunction(()=>document.querySelectorAll('[data-issue-row]').length>=2,undefined,{timeout:180000})
  await page.waitForTimeout(10000)
  const scale=await page.evaluate(()=>({issueRows:document.querySelectorAll('[data-issue-row]').length,elements:document.querySelectorAll('*').length,animations:document.getAnimations().length,poolCountersPresent:!!globalThis.__podiumSidebarPerf}))
  if(intervention==='meter'){await page.getByRole('button',{name:'Close performance panel'}).click();await page.waitForTimeout(10000)}
  if(intervention!=='baseline' && intervention!=='css' && intervention!=='meter'){await page.evaluate(key=>{if(!globalThis.__idleAblations)throw new Error('Ablation control missing');globalThis.__idleAblations.set(key)},intervention);await page.waitForTimeout(10000)}
  console.log(JSON.stringify({event:'hydrated',label,turn,provenance,scale}))
  for(const mode of (args.has('idle-only')?['idle']:['idle','activity'])){
   if(intervention==='css') await page.addStyleTag({content:'*,*::before,*::after {animation:none !important;transition:none !important;}'})
   await page.evaluate(()=>globalThis.__idleProbe.reset())
   let before
   await client.send('Profiler.enable')
   await client.send('Profiler.setSamplingInterval',{interval:1000})
   const trace=[]
   const onData=e=>trace.push(...e.value)
   client.on('Tracing.dataCollected',onData)
   await client.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing',options:'record-as-much-as-possible'})
   await client.send('Profiler.start')
   before=Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]))
   const startedAt=new Date().toISOString(),start=Date.now(),actions=[]
   if(mode==='activity'){
    const rowIds=await page.locator('[data-issue-row]').evaluateAll(es=>es.slice(0,2).map(e=>e.getAttribute('data-issue-row')))
    const press=async(kind,locator)=>{const at=Date.now();try{await locator.click({timeout:15000});actions.push({kind,ok:true,ms:Date.now()-at})}catch{actions.push({kind,ok:false,ms:Date.now()-at})}}
    await page.waitForTimeout(10000)
    // Select by in-memory ID only; no titles or identifiers enter evidence.
    await press('issue',page.locator(`[data-issue-row="${CSSescape(rowIds[0])}"]`).first())
    await page.waitForTimeout(10000)
    await press('issue',page.locator(`[data-issue-row="${CSSescape(rowIds[1])}"]`).first())
    await page.waitForTimeout(10000)
    const inactiveTab=page.locator('[data-tab-drag-id]:not(.native-tab-active):visible').first()
    const session=await inactiveTab.count()?inactiveTab:page.locator('[data-session]:visible').first().locator('button').first()
    await press('session',session)
   }
   const remaining=duration-(Date.now()-start)
   if(remaining>0)await page.waitForTimeout(remaining)
   const seconds=(Date.now()-start)/1000
   const after=Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]))
   const {profile}=await client.send('Profiler.stop')
   const complete=new Promise(resolve=>client.once('Tracing.tracingComplete',resolve))
   await client.send('Tracing.end');await complete
   client.off('Tracing.dataCollected',onData)
   const counters=await page.evaluate(()=>globalThis.__idleProbe.read())
   const stamp=`${label}-${turn}-${mode}-${intervention}`
   save(stamp+'.cpuprofile',profile);save(stamp+'.trace.json',{traceEvents:trace});save(stamp+'.counters.json',counters);save(stamp+'.metrics.json',{before,after})
   const mapped=resolveProfile(profile,root);save(stamp+'.resolved-private.json',mapped.privateNodes)
   const timeline={}
   for(const e of trace)if(e.ph==='X'&&e.dur){const x=timeline[e.name]??={count:0,ms:0};x.count++;x.ms+=e.dur/1000}
   for(const x of Object.values(timeline))x.ms=+x.ms.toFixed(2)
   const delta=k=>+(after[k]-before[k]).toFixed(6)
   const summary={stamp,label,turn,mode,startedAt,seconds,metricsSeconds:delta('Timestamp'),provenance,scale,mainThreadBusyPct:+(delta('TaskDuration')/delta('Timestamp')*100).toFixed(2),scriptMs:delta('ScriptDuration')*1000,layoutMs:delta('LayoutDuration')*1000,styleMs:delta('RecalcStyleDuration')*1000,layoutCount:delta('LayoutCount'),styleCount:delta('RecalcStyleCount'),longTasks:counters.longTasks.length,longTaskMs:+counters.longTasks.reduce((a,b)=>a+b.ms,0).toFixed(1),maxLongTaskMs:Math.max(0,...counters.longTasks.map(e=>e.ms)),reactCommits:counters.commits,reactCommitsPerSecond:+(counters.commits/seconds).toFixed(3),timers:Object.fromEntries(Object.entries(counters.timers).map(([k,v])=>[k,{created:v.created,fires:v.fires,perSecond:+(v.fires/seconds).toFixed(3),callbackMs:+v.ms.toFixed(2),topCallbacks:Object.entries(v.byName).sort((a,b)=>b[1].ms-a[1].ms).slice(0,8).map(([functionName,v])=>({function:functionName,fires:v.fires,ms:+v.ms.toFixed(2)}))}])),mobx:counters.mobx?{...counters.mobx,perSecond:Object.fromEntries(Object.entries(counters.mobx.counts).map(([k,v])=>[k,+(v/seconds).toFixed(3)]))}:null,store:counters.store,pool:counters.pool,websocket:counters.ws,errors:counters.errors,actions,timeline,cpu:mapped.summary}
   summaries.push(summary)
   save((args.get('run')||'baseline')+'-summary.json',{capturedOn:'ludovico',summaries})
   console.log(JSON.stringify({event:'window',stamp,seconds,busyPct:summary.mainThreadBusyPct,longTasks:summary.longTasks,commitsPerSecond:summary.reactCommitsPerSecond,poolCounters:!!counters.pool,topSelf:summary.cpu.topSelf.slice(0,6)}))
  }
  await context.close()
 }
} finally {
 await browser.close();await browserServer.close()
 for(const {server} of servers.values())await server.httpServer.close()
}
function CSSescape(s){return s.replaceAll('\\','\\\\').replaceAll('"','\\"')}
