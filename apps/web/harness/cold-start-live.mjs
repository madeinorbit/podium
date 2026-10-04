/** A1: private production preview over the existing live backend on ludovico.
 * No corpus or cookie leaves this host; saved results contain counts/timings. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { hostname, loadavg } from 'node:os'
import { extname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import { paintOf } from './browser-paint.ts'

if (hostname() !== 'ludovico') throw Error('Operator data must stay on ludovico')
const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const arm = arg('arm', 'latest'), samples = Number(arg('samples', '8'))
const dist = resolve(arg('dist', `.artifacts/cold-start/live/${arm}`))
const baselineDist = arg('baseline-dist', '') ? resolve(arg('baseline-dist','')) : undefined
const out = resolve(arg('out', `.artifacts/cold-start/live-results/${arm}`))
const variantQueries = {
  control:'', memo:'coldStartFlatMemo=1', reader:'coldStartNoIssueReaderIndex=1',
  attach:'coldStartNoDormantAttach=1', hydrate:'coldStartNoDiscardedHydrate=1',
  all:'coldStartFlatMemo=1&coldStartNoIssueReaderIndex=1&coldStartNoDormantAttach=1&coldStartNoDiscardedHydrate=1',
  facade:'coldStartLazyFacade=1', targets:'coldStartLazyTargets=1', facts:'coldStartBulkSessionFacts=1',
  candidates:'coldStartFlatMemo=1&coldStartLazyFacade=1&coldStartLazyTargets=1&coldStartBulkSessionFacts=1&coldStartNoDiscardedHydrate=1',
  quick:'coldStartQuickMemos=1',
  quickCandidates:'coldStartQuickMemos=1&coldStartLazyFacade=1&coldStartLazyTargets=1&coldStartBulkSessionFacts=1&coldStartNoDiscardedHydrate=1',
  replaceQueries:'coldStartSkipReplaceQueries=1', attachAll:'coldStartNoAttachedScreens=1',
  minimalAttach:'coldStartMinimalAttach=1', residentReplace:'coldStartResidentReplace=1',
  noEntityPayload:'coldStartNoEntityPayload=1',
  chunkWrites:'coldStartChunkWrites=1',
  chunkBounded:'coldStartChunkWrites=1&coldStartQuickMemos=1&coldStartLazyFacade=1&coldStartLazyTargets=1&coldStartBulkSessionFacts=1&coldStartSkipReplaceQueries=1',
  bounded:'coldStartQuickMemos=1&coldStartLazyFacade=1&coldStartLazyTargets=1&coldStartBulkSessionFacts=1&coldStartSkipReplaceQueries=1',
}
const variants = baselineDist ? ['baseline','production'] : arg('variants','').split(',').filter(Boolean)
if(!baselineDist && variants.some(name=>!(name in variantQueries)))throw Error('Unknown live ablation')
const live = 'http://127.0.0.1:18787'
const token = execFileSync('podium', ['auth', 'mint-session', '--print-only', '--ttl', '20m'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim()
if (!token || !Number.isInteger(samples) || samples < 1) throw Error('Invalid live capture setup')
mkdirSync(out, {recursive:true})
const result = {version:1, arm, method:'A1 private production preview; connected live backend; fresh browser context per cold sample', transport:'identity HTTP bootstrap, service workers blocked', build:JSON.parse(readFileSync(resolve(dist,'podium-build.json'),'utf8')), collectorSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'), host:hostname(), samples, variants, query:arg('query',''), startedAt:new Date().toISOString(), actions:[], errors:[], counts:[], pid:process.pid}
if(baselineDist)result.baselineBuild=JSON.parse(readFileSync(resolve(baselineDist,'podium-build.json'),'utf8'))
const save = () => writeFileSync(resolve(out, 'run.json'), JSON.stringify(result,null,2)+'\n')
writeFileSync(resolve(out,'collector-source.mjs'),readFileSync(new URL(import.meta.url)))
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.png':'image/png'}
const preview = previewDist => Bun.serve({
  hostname:'127.0.0.1', port:0, idleTimeout:120,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (request.headers.get('upgrade') === 'websocket') {
      const upstream = new WebSocket(live.replace('http','ws')+url.pathname+url.search, {headers:{cookie:`podium_session=${token}`,origin:live}})
      upstream.binaryType = 'arraybuffer'
      const data = {upstream, queued:[], incoming:[], socket:undefined, closed:false}
      // The upstream can open before Bun calls the downstream open handler.
      // Install listeners now so its hello/bootstrap frames cannot be lost.
      upstream.addEventListener('open',()=>{for(const value of data.queued.splice(0))upstream.send(value)})
      upstream.addEventListener('message',event=>{
        if(data.socket)data.socket.send(event.data)
        else data.incoming.push(event.data)
      })
      const close = () => {data.closed=true;data.socket?.close()}
      upstream.addEventListener('close',close)
      upstream.addEventListener('error',close)
      if (server.upgrade(request,{data})) return
      upstream.close(); return new Response('Upgrade refused',{status:400})
    }
    if (url.pathname === '/__benchmark_blank') return new Response('<!doctype html><title>Preparation</title>',{headers:{'content-type':'text/html'}})
    const pathname = decodeURIComponent(url.pathname)
    const file = Bun.file(resolve(previewDist,'.'+pathname))
    if (request.method === 'GET' && pathname !== '/' && await file.exists()) return new Response(file,{headers:{'content-type':mime[extname(pathname)]??file.type}})
    if (request.method === 'GET' && (pathname==='/' || !/\.(js|css|json|map|png|svg|woff2)$/.test(pathname)) && !/^\/(auth|trpc|sync|version|health|api)(\/|$)/.test(pathname))
      return new Response(Bun.file(resolve(previewDist,'index.html')),{headers:{'content-type':'text/html'}})
    const headers = new Headers(request.headers)
    headers.set('cookie',`podium_session=${token}`); headers.delete('host')
    // Bun 1.4.2 cannot proxy Chromium's streaming zstd bootstrap. Both arms
    // use identity transport; this proxy's cost is outside client CPU claims.
    headers.set('accept-encoding','identity')
    headers.set('connection','close')
    let response
    try {
      response = await fetch(live+url.pathname+url.search,{method:request.method,headers,body:request.method==='GET'||request.method==='HEAD'?undefined:await request.arrayBuffer(),redirect:'manual',signal:request.signal,keepalive:false})
    } catch(error) {
      result.proxyErrors??=[]
      result.proxyErrors.push({at:new Date().toISOString(),path:url.pathname,aborted:request.signal.aborted,code:error.code??error.name})
      return new Response(null,{status:request.signal.aborted?499:502})
    }
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length')
    return new Response(response.body,{status:response.status,headers:responseHeaders})
  },
  websocket:{
    open(socket) {
      const data = socket.data
      data.socket=socket
      if(data.closed){socket.close();return}
      for(const value of data.incoming.splice(0))socket.send(value)
    },
    message(socket, value) {const {upstream,queued}=socket.data; if(upstream.readyState===1)upstream.send(value);else queued.push(value)},
    close(socket) {socket.data.socket=undefined;socket.data.closed=true;socket.data.upstream.close()},
  },
})
const server = preview(dist), baselineServer = baselineDist ? preview(baselineDist) : undefined
let browser, diagnosticPage
save()
try {
  browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
  result.browser = browser.version()
  let index=0
  for(let round=0;round<samples+1;round++) {
    const order=variants.length?[...variants.slice(round%variants.length),...variants.slice(0,round%variants.length)]:['production']
    for(const variant of order) {
    const base = `http://127.0.0.1:${(variant==='baseline'?baselineServer:server).port}`
    const profile = round===samples
    const query=[variants.length && !baselineDist?'coldStartTrace=1':'',variantQueries[variant]??'',arg('query','')].filter(Boolean).join('&')
    const context = await browser.newContext({viewport:{width:1600,height:1000},serviceWorkers:'block'})
    await context.addCookies([{name:'podium_session',value:token,url:base}])
    const page = await context.newPage()
    diagnosticPage=page
    const sampleIndex=index
    page.on('pageerror',error=>result.errors.push({index:sampleIndex,at:new Date().toISOString(),kind:'pageerror',message:error.message.slice(0,250)}))
    page.on('response',response=>{if(response.status()>=400)result.errors.push({index:sampleIndex,at:new Date().toISOString(),kind:'http',status:response.status(),path:new URL(response.url()).pathname})})
    await page.goto(base+'/__benchmark_blank')
    await page.addInitScript(()=>{
      localStorage.setItem('podium.panelMode','chat')
      localStorage.setItem('podium.panelModeDefault','chat')
      performance.mark('comparison:navigation-start',{startTime:0})
      window.__comparisonStartup=false
      const observer=new MutationObserver(()=>{
        if(window.__comparisonStartup || document.querySelector('[data-testid="boot-splash"]'))return
        const row=[...document.querySelectorAll('aside [data-issue-row]')].find(row=>{
          const r=row.getBoundingClientRect()
          return r.width>0 && r.height>0 && r.y>=0 && r.bottom<=innerHeight && row.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))
        })
        if(row){window.__comparisonStartup=true;performance.mark('comparison:startup-dom');observer.disconnect()}
      })
      observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true})
    })
    const cdp=await context.newCDPSession(page)
    await cdp.send('Performance.enable',{timeDomain:'threadTicks'})
    const events=[]
    cdp.on('Tracing.dataCollected',({value})=>events.push(...value))
    await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,blink.user_timing',transferMode:'ReportEvents'})
    if(profile){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:100});await cdp.send('Profiler.start')}
    const load=loadavg()
    const startedAt=new Date().toISOString()
    await page.goto(`${base}/?server=${encodeURIComponent(base.replace('http','ws'))}&e2e=1&${query}`,{waitUntil:'domcontentloaded',timeout:120000})
    await page.waitForFunction(()=>window.__comparisonStartup,undefined,{timeout:120000})
    await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))
    if(profile)writeFileSync(resolve(out,`${index}.cpuprofile`),JSON.stringify((await cdp.send('Profiler.stop')).profile))
    const complete=new Promise(done=>cdp.once('Tracing.tracingComplete',done))
    await cdp.send('Tracing.end');await complete
    const measured=paintOf(events,'comparison:navigation-start','comparison:startup-dom')
    const input=events.find(event=>event.name==='comparison:navigation-start')
    const dom=events.find(event=>event.name==='comparison:startup-dom')
    const paint=events.filter(event=>event.name==='Paint'&&event.ph==='X'&&event.pid===input.pid&&event.ts>=dom.ts).sort((a,b)=>a.ts-b.ts)[0]
    const mainThreadCpuMs=typeof input.tts==='number'&&typeof paint.tts==='number'&&typeof paint.tdur==='number'?(paint.tts+paint.tdur-input.tts)/1000:null
    const phaseMetrics=await page.evaluate(end=>(window.__coldStartMetrics??[]).filter(entry=>entry.end<=end),measured.inputToPaintMs)
    const assets=await page.evaluate(end=>performance.getEntriesByType('resource').filter(entry=>/\.(js|css)(\?|$)/.test(entry.name)&&entry.startTime<=end).map(entry=>({path:new URL(entry.name).pathname,ms:entry.duration,encodedBytes:entry.encodedBodySize,decodedBytes:entry.decodedBodySize})),measured.inputToPaintMs)
    const paintAt=await page.evaluate(ms=>new Date(performance.timeOrigin+ms).toISOString(),measured.inputToPaintMs)
    result.actions.push({index,round,variant,query,profiled:profile,load,startedAt,paintAt,...measured,mainThreadCpuMs,phaseMetrics,assets})
    writeFileSync(resolve(out,`${index}.trace.json.gz`),gzipSync(JSON.stringify(events)))
    const counts=await page.evaluate(async()=>{
      const counts={}
      for(const {name} of await indexedDB.databases()) {
        const db=await new Promise((done,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>done(r.result);r.onerror=()=>reject(r.error)})
        if(db.objectStoreNames.contains('entities'))await new Promise((done,reject)=>{const r=db.transaction('entities','readonly').objectStore('entities').getAll();r.onsuccess=()=>{for(const row of r.result)counts[row.entity]=(counts[row.entity]??0)+1;done()};r.onerror=()=>reject(r.error)})
        db.close()
      }
      return {entities:counts,rows:document.querySelectorAll('aside [data-issue-row]').length,elements:document.querySelectorAll('*').length}
    })
    // getAll runs after the write transaction, so this records persistence
    // work that continued after the first paint rather than hiding it.
    result.actions.at(-1).settledPhaseMetrics=await page.evaluate(()=>window.__coldStartMetrics??[])
    result.counts.push(counts);save()
    console.log(`live ${arm}/${variant} ${index}: ${measured.inputToPaintMs.toFixed(1)} ms${profile?' (profile, excluded)':''}; ${counts.entities.issueProjection??0} issues, ${counts.entities.session??0} sessions`)
    await context.close()
    index++
    }
  }
  result.status='complete'
} catch(error) {
  result.status='failed';result.failure=String(error)
  result.failureBoundary=await diagnosticPage?.evaluate(()=>({bootSplash:!!document.querySelector('[data-testid="boot-splash"]'),aside:!!document.querySelector('aside'),rows:document.querySelectorAll('aside [data-issue-row]').length,dialogs:document.querySelectorAll('[role="dialog"]').length,cannotStart:/cannot start/i.test(document.body.innerText),signIn:/sign in/i.test(document.body.innerText)})).catch(()=>null)
  console.error(result.failure);console.error('Failure boundary '+JSON.stringify(result.failureBoundary));process.exitCode=1
}
finally {result.endedAt=new Date().toISOString();result.loadEnd=loadavg();save();await browser?.close();server.stop(true);baselineServer?.stop(true)}
