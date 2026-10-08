/** Private live-data capture; evidence exports only cardinalities and source names. */
import { chromium } from '@playwright/test'
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
  const p = { commits:0, unmounts:0, errors:0, messages:0, bytes:0, freeze:false, paused:[] }
  globalThis.__memoryProbe = p
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber:true, renderers:new Map(), inject(renderer) { this.renderers.set(this.renderers.size+1,renderer); return this.renderers.size }, onCommitFiberRoot() { p.commits++ }, onCommitFiberUnmount() { p.unmounts++ }, checkDCE() {} }
  addEventListener('error', () => p.errors++)
  addEventListener('unhandledrejection', () => p.errors++)
  const Ws = globalThis.WebSocket
  globalThis.WebSocket = class extends Ws { constructor(...a) { super(...a); this.addEventListener('message',e => { p.messages++; p.bytes += typeof e.data==='string' ? e.data.length : e.data?.byteLength ?? e.data?.size ?? 0; if (p.freeze) e.stopImmediatePropagation() },true) } }
  localStorage.setItem('podium.panelMode','chat')
}
function processes(pid) {
  const found=[]
  function visit(id) { try { const stat=readFileSync(`/proc/${id}/status`,'utf8'); const cmd=readFileSync(`/proc/${id}/cmdline`,'utf8'); const kind=/--type=([^\0 ]+)/.exec(cmd)?.[1]??'browser'; const num=k=>Number(new RegExp(`^${k}:\\s+(\\d+)`,'m').exec(stat)?.[1]??0); found.push({pid:id,kind,rssKiB:num('VmRSS'),virtualKiB:num('VmSize'),swapKiB:num('VmSwap'),hwmKiB:num('VmHWM')}); const children=readFileSync(`/proc/${id}/task/${id}/children`,'utf8').trim(); if(children) for(const child of children.split(/\s+/))visit(Number(child)) } catch {} }
  visit(pid); return found
}
const server = await chromium.launchServer({headless:true,executablePath:'/home/mgw/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--enable-precise-memory-info']})
const browser = await chromium.connect(server.wsEndpoint())
save('owned-pids.json',{collector:process.pid,browser:server.process().pid})
save('browser-endpoint.json',{endpoint:server.wsEndpoint()})
const context = await browser.newContext({ viewport:{width:1600,height:1000} })
await context.addCookies([{name:'podium_session',value:token,url}])
await context.addInitScript(init)
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
const samples=[]
const failures=[]
page.on('pageerror', e=>{ failures.push({name:e.name,message:e.message,stack:e.stack}); save('errors-private.json',failures); console.log(JSON.stringify({event:'page-error',count:failures.length})) })
async function sample(minute, phase) {
  await cdp.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(150)
  await cdp.send('HeapProfiler.collectGarbage')
  const heap=await cdp.send('Runtime.getHeapUsage')
  const dom=await cdp.send('Memory.getDOMCounters')
  const metrics=Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]))
  const browserStats=await page.evaluate(async () => {
    const p=globalThis.__memoryProbe
    const animations={}
    for(const a of document.getAnimations()) { const key=a.animationName??a.constructor.name; const v=animations[key]??={total:0,running:0,keyframes:0}; v.total++; v.running+=a.playState==='running'?1:0; v.keyframes+=a.effect?.getKeyframes().length??0 }
    const usage=await navigator.storage?.estimate?.().catch(()=>null)
    const databases=await indexedDB.databases().catch(()=>[])
    const stores=[]
    for(const info of databases) { if(!info.name)continue; await new Promise(resolve => { const request=indexedDB.open(info.name); request.onerror=()=>resolve(); request.onsuccess=async()=>{ const db=request.result; try { for(const name of db.objectStoreNames) { const tx=db.transaction(name,'readonly'); const count=await new Promise(r=>{ const q=tx.objectStore(name).count(); q.onsuccess=()=>r(q.result); q.onerror=()=>r(null) }); stores.push({name,count}) } } finally { db.close(); resolve() } } }) }
    return {commits:p.commits,unmounts:p.unmounts,errors:p.errors,messages:p.messages,bytes:p.bytes,elements:document.querySelectorAll('*').length,issueRows:document.querySelectorAll('[data-issue-row]').length,animations,storageBytes:usage?.usage??null,storageDetails:usage?.usageDetails??null,idbDatabaseCount:databases.length,idbStores:stores,serviceWorkerControlled:!!navigator.serviceWorker?.controller,resources:performance.getEntriesByType('resource').length}
  })
  const value={minute,phase,at:new Date().toISOString(),heap,dom,metrics,...browserStats,processes:processes(server.process().pid)}
  samples.push(value); save('samples.json',samples); console.log(JSON.stringify(value))
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
  await cdp.send('Performance.enable')
  await page.goto(url+'?e2e=1',{waitUntil:'domcontentloaded',timeout:30000})
  console.log(JSON.stringify({event:'loaded', ...(await page.evaluate(()=>({elements:document.querySelectorAll('*').length,rows:document.querySelectorAll('[data-issue-row]').length,password:!!document.querySelector('input[type=password]'),workScroll:!!document.querySelector('[data-testid=work-scroll]'),errors:globalThis.__memoryProbe.errors,loaderText:document.querySelector('[data-testid=work-scroll]')?undefined:document.body.textContent.slice(0,350),inputs:[...document.querySelectorAll('input')].map(e=>e.type)})))}))
  await page.waitForFunction(()=>!!document.querySelector('[data-testid=work-scroll]'),undefined,{timeout:180000}).catch(async e=>{console.log(JSON.stringify({event:'startup-failure',...(await page.evaluate(async()=>({auth:await fetch('/auth/status').then(r=>r.json()).then(v=>({authed:v.authed,needsAuth:v.needsAuth,readiness:v.readiness?.state})),elements:document.querySelectorAll('*').length})))}));throw e})
  await page.waitForTimeout(10000)
  const identity=await page.evaluate(async()=>{ const v=await fetch('/version').then(r=>r.json()); return {appVersion:v.appVersion,sourceDigest:v.sourceDigest,web:v.web?.appVersion,webDigest:v.web?.digest} })
  if(args.has('dist'))identity.bundleManifest=(()=>{const m=JSON.parse(readFileSync(join(args.get('dist'),'podium-build-manifest.json'),'utf8'));return {sourceCommit:m.sourceCommit,buildStamp:m.buildStamp,fileCount:m.fileCount}})(); save('provenance.json',identity); console.log(JSON.stringify({event:'hydrated',identity}))
  await sample(0,'idle')
  if(args.has('start-snapshot'))await snapshot('start')
  const started=Date.now()
  for(let minute=1;minute<=minutes;minute++) {
    if(minute===Number(args.get('warm-at')??2)) {
      const ids=await page.locator('[data-issue-row]').evaluateAll(es=>es.filter(e=>e.getAttribute('data-selected')!=='true').slice(0,2).map(e=>e.getAttribute('data-issue-row')))
      for(const id of ids) { try { await page.locator(`[data-issue-row=${JSON.stringify(id)}]`).first().click({timeout:20000}); await page.waitForTimeout(5000) } catch { console.log(JSON.stringify({event:'switch-failed',minute})) } }
      const tab=page.locator('[data-tab-drag-id]:not([title]):not(.native-tab-active):visible').first().locator('button[data-pressable]').first()
      if(await tab.count())try { await tab.click({timeout:20000}) } catch {}
      console.log(JSON.stringify({event:'warmed',minute}))
    }
    if(minute===Number(args.get('freeze-at')??-1)) { await page.evaluate(()=>globalThis.__memoryProbe.freeze=true); console.log(JSON.stringify({event:'freeze-feed',minute})) }
    if(minute===Number(args.get('pause-css-at')??-1)) { await page.evaluate(()=>{ for(const a of document.getAnimations())a.pause() }); console.log(JSON.stringify({event:'pause-css',minute})) }
    const left=started+minute*60000-Date.now()
    if(left>0)await page.waitForTimeout(left)
    await sample(minute,minute>=Number(args.get('freeze-at')??Infinity)?'feed-frozen':minute>=Number(args.get('pause-css-at')??Infinity)?'css-paused':minute>=Number(args.get('warm-at')??2)?'warm-idle':'idle')
  }
  if(args.has('snapshots'))await snapshot('end')
} finally { await context.close(); await browser.close(); await server.close() }
