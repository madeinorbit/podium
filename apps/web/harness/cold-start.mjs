/** Foreground production app comparison. One implementation per invocation. */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statfsSync, existsSync } from 'node:fs'
import { hostname, cpus, loadavg } from 'node:os'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium, devices } from '@playwright/test'
import { paintOf } from './browser-paint.ts'
import * as model from '@podium/model'
import { FeedChange, ServerMessage } from '@podium/protocol'
import { readSyncStream } from '@podium/client-core/sync-stream'

const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const mode = arg('mode', 'probe'), scale = Number(arg('scale', '1')), surface = arg('surface', 'web')
const arm = arg('arm', ''), round = Number(arg('round', '0')), samples = Number(arg('samples', '8'))
const query = arg('query', '')
const paired = process.argv.includes('--paired')
const variantQueries = {
  control: '', memo:'coldStartFlatMemo=1', reader:'coldStartNoIssueReaderIndex=1',
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
  chunkQueries:'coldStartChunkWrites=1&coldStartSkipReplaceQueries=1',
  chunkBounded:'coldStartChunkWrites=1&coldStartQuickMemos=1&coldStartLazyFacade=1&coldStartLazyTargets=1&coldStartBulkSessionFacts=1&coldStartSkipReplaceQueries=1',
  bounded:'coldStartQuickMemos=1&coldStartLazyFacade=1&coldStartLazyTargets=1&coldStartBulkSessionFacts=1&coldStartSkipReplaceQueries=1',
}
const variants = arg('variants','').split(',').filter(Boolean)
if (variants.some(name => !(name in variantQueries))) throw Error('Unknown diagnostic variant')
let activeVariant = 'production'
let activeQuery = query
const controlOnly=process.argv.includes('--control-only')
const backgroundOnly=process.argv.includes('--background-only')
const startupOnly=true
if (hostname() !== 'flatblock' || (!process.argv.includes('--lease-confirmed') && !process.argv.includes('--external-lease'))) throw Error('flatblock with caller-owned bench (timing) or meter (probe/heap) lease required')
if (!['probe', 'timing', 'memory'].includes(mode) || !['web', 'phone'].includes(surface) || ![1,4].includes(scale) || !arm) throw Error('Invalid capture arguments')
const out = resolve(arg('out', `.artifacts/old-vs-new/${mode}-${arm}-${surface}-${scale}x-r${round}`))
if (existsSync(resolve(out,'run.json'))) throw Error('Capture output already exists; use a fresh round')
mkdirSync(out, { recursive: true })
const corpusBytes = readFileSync(`.artifacts/old-vs-new/corpus-${scale}x.json`)
const corpus = JSON.parse(corpusBytes), synthetic = controlOnly?[]:JSON.parse(readFileSync(`.artifacts/old-vs-new/rows-${scale}x.json`, 'utf8'))
const issuesById=new Map(corpus.issues.map(issue=>[issue.id,issue])), descendantSessionCounts=new Map()
for(const session of corpus.sessions) {
  let id=session.issueId;const seen=new Set()
  while(issuesById.has(id) && !seen.has(id)) {
    seen.add(id);descendantSessionCounts.set(id,(descendantSessionCounts.get(id)??0)+1);id=issuesById.get(id).parentId
  }
}
const rankedCorpusRoots=corpus.issues.filter(issue=>!issue.parentId && !issue.closedAt && !issue.archived && issue.stage!=='draft')
  .sort((a,b)=>(descendantSessionCounts.get(b.id)??0)-(descendantSessionCounts.get(a.id)??0))
// Keep the folding target stable while excluding unavailable missions: deferred
// and tucked roots are intentionally absent from the Work sidebar.
const groupCorpusRepoId=rankedCorpusRoots[0].repoId
const largeMissionTargets=rankedCorpusRoots.filter(issue=>!issue.tuckedAt && (!issue.deferUntil || Date.parse(issue.deferUntil)<=corpus.fixedNow)).slice(0,2)
if(controlOnly && mode!=='probe')throw Error('Control-only is diagnostic, never performance evidence')
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirtyProduct = execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages'], { encoding:'utf8' }).trim()
if (dirtyProduct === 'M packages/api-types/src/index.d.ts') execFileSync('git',['restore','--source=HEAD','--','packages/api-types/src/index.d.ts'])
else if (dirtyProduct) throw Error(`Product checkout is dirty: ${dirtyProduct}`)
const declarationTracked=execFileSync('git',['ls-files','packages/api-types/src/index.d.ts'],{encoding:'utf8'}).trim().length>0
const productDirectories = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages']
const productTreeSha256 = createHash('sha256').update(execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', ...productDirectories])).digest('hex')
const harnessBytes=readFileSync(new URL(import.meta.url))
writeFileSync(resolve(out,'harness-source.mjs'),harnessBytes)
writeFileSync(resolve(out,'browser-paint-source.ts'),readFileSync(new URL('./browser-paint.ts',import.meta.url)))
const result = { version:1, mode, arm, comparisonArm:arg('comparison-arm',arm==='old'?'new':arm), round, surface, scale, sha, productTreeSha256,purpose:round>=100?'selector-calibration':'measurement',
  harnessSha256:createHash('sha256').update(harnessBytes).digest('hex'),
  durationTimeDomain:'threadTicks',
  startupBoundary:surface==='web'?'sidebar-issue-row':'phone-issue-row',
  httpCache:'disabled by bootstrap request routing',
  warmStartup:'Reload with retained durable data and preferences; full augmented bootstrap replay',
  sameOriginTracePriming:true,
  semanticSha256:createHash('sha256').update(corpusBytes).digest('hex'),controlOnly,backgroundOnly,query,variants,paired,
  build:JSON.parse(readFileSync('apps/web/dist/podium-build.json','utf8')),
  diagnostic:existsSync('apps/web/dist/ablation-provenance.json'),
  corpus: { syntheticIssues:corpus.issues.length, syntheticSessions:corpus.sessions.length, extraLiveIssues:2, extraLiveSessions:2 },
  largeMissionTargets:largeMissionTargets.map(issue=>({id:issue.id,repoId:issue.repoId,assignedDescendantSessions:descendantSessionCounts.get(issue.id)})),
  startedAt:new Date().toISOString(), host:hostname(), cpu:cpus()[0].model, cores:cpus().length,
  loadStart:loadavg(), actions:[], unavailable:[], background:[], errors:[], pids:[{role:'collector',pid:process.pid}], bootstraps:[], status:'running' }
let evidenceWriteFailure
const save = () => {
  if(evidenceWriteFailure)throw evidenceWriteFailure
  // Preserve the previous complete ledger if the shared disk fills mid-write.
  writeFileSync(resolve(out,'run.pending'),JSON.stringify(result,null,2)+'\n')
  renameSync(resolve(out,'run.pending'),resolve(out,'run.json'))
}
save()
const port = Number(arg('port',surface === 'web' ? '19561' : '19562'))
const base = `http://127.0.0.1:${port}`, relay = base.replace('http','ws')
const env = { ...process.env, PORT:String(port), PODIUM_NO_RELAY:'1' }
for (const key of Object.keys(env)) if (/^PODIUM_(SESSION|AGENT|CODEX_HOOK|ISSUE_RELAY|INSTANCE|HOME|STATE_DIR|AGENT_HOME|SERVER|PORT)/.test(key)) delete env[key]
const server = spawn(process.execPath, ['--conditions=@podium/source','tests/e2e/serve-harness.ts'], { cwd:process.cwd(), env, stdio:['ignore','pipe','pipe'] })
result.pids.push({ role:'harness', pid:server.pid })
let serverLog=Buffer.alloc(0),serverLogBytes=0
for(const stream of [server.stdout,server.stderr])stream.on('data',data=>{
  serverLog=Buffer.concat([serverLog,data]).subarray(-1048576)
  if(serverLogBytes>=1048576){result.serverLogTruncated=true;return}
  try {
    const retained=data.subarray(0,1048576-serverLogBytes)
    appendFileSync(resolve(out,'server.log'),retained);serverLogBytes+=retained.length
  } catch(error) { evidenceWriteFailure=error }
})
let browser, fixture
const cpuTicks = () => readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number)
const pause = ms => new Promise(done => setTimeout(done, ms))
const rpc = async (path, input) => {
  const response = await fetch(`${base}/trpc/${path}`, input === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})
  if (!response.ok) throw Error(`${path} ${response.status}: ${await response.text()}`)
  return (await response.json()).result.data
}
const frames = async page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name,m.value]))
async function trace(cdp) {
  const events = [], collect = ({value}) => events.push(...value)
  cdp.on('Tracing.dataCollected',collect)
  await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,cc,viz,benchmark',transferMode:'ReportEvents'})
  return async () => {
    const completed = new Promise(done => cdp.once('Tracing.tracingComplete',done))
    await cdp.send('Tracing.end'); await completed; cdp.off('Tracing.dataCollected',collect); return events
  }
}
function intervalMs(events, names, pid, tid, begin, end,thread=false) {
  const all = events.filter(e=>names.includes(e.name) && e.ph==='X' && e.pid===pid && (tid===undefined || e.tid===tid))
    .filter(e=>!thread || typeof e.tts==='number' && typeof e.tdur==='number')
    .map(e=>[Math.max(begin,thread?e.tts:e.ts),Math.min(end,thread?e.tts+e.tdur:e.ts+(e.dur??0))]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0])
  const merged=[]
  for(const [a,b] of all) { const last=merged.at(-1); if(last && a<=last[1]) last[1]=Math.max(b,last[1]); else merged.push([a,b]) }
  return merged.reduce((sum,[a,b])=>sum+b-a,0)/1000
}
const live = []
const outputEpochs = new Map()
let outputSeq = 0
const traffic = {feedDeltas:0,outputFrames:0,syntheticHeartbeat:0,syntheticIssue:0,syntheticOutput:0}
let meta, seq=0, memberId, controls, seeded=false
let extraChanges, observedReplay
function prepareExtras() {
  const rows=synthetic.map(row=>{
    const value={...row.value}
    if(['issueUserState','sessionUserState'].includes(row.entity))value.userId=memberId
    return {...row,value,entityId:row.entity==='issueUserState'?model.issueUserStateRowId(memberId,value.entityId):row.entity==='sessionUserState'?model.sessionUserStateRowId(memberId,value.sessionId):row.entityId}
  })
  extraChanges=[]
  for(let offset=0;offset<rows.length;offset+=64)extraChanges.push(JSON.stringify(rows.slice(offset,offset+64).map((row,index)=>({...row,seq:index+1,op:'upsert'}))))
}
function bootstrapBody(records) {
    const first=records[0], complete=records.at(-1)
    if(first.type!=='syncMeta' || first.mode!=='snapshot')return null
    const chunks=records.filter(x=>x.type==='feedBootstrap')
    // The isolated keyecho agent has no transcript provider. Advertise an empty
    // transcript on the comparison sessions so both production chat composers
    // can be exercised; this is identical fixture data, not product code.
    const changes=chunks.flatMap(x=>x.changes)
    const comparisonSession=id=>controls?.some(control=>control.session.sessionId===id || control.secondSession?.sessionId===id)
    for(const change of changes) if(change.entity==='session' && comparisonSession(change.entityId)) change.value.transcriptAvailable=true
    if(first.seq<64 || !chunks.length)throw Error('Canonical bootstrap cannot admit prevalidated fixture chunks')
    const count=changes.length+synthetic.length
    const original=chunks.map(x=>{const chunk={...x,last:false,totalRows:count};delete chunk.countsByEntity;return JSON.stringify(chunk)})
    const extra=extraChanges.map((rows,index)=>{
      const template={...chunks[0],last:index===extraChanges.length-1,totalRows:count,changes:null};delete template.countsByEntity
      return JSON.stringify(template).replace('"changes":null','"changes":'+rows)
    })
    if(!extra.length)original[original.length-1]=JSON.stringify({...chunks.at(-1),last:true,totalRows:count})
    const all=[...original,...extra]
    const body=[JSON.stringify({...first,totalRows:count}),...all,JSON.stringify({...complete,rows:count,records:all.length})].join('\n')+'\n'
    return {body,first,chunks,count,changes}
}
async function bindContext(context) {
  await context.route('**/sync/bootstrap*',async route=>{
    const response=await route.fetch(), records=(await response.text()).trim().split('\n').map(x=>JSON.parse(x))
    const prepared=bootstrapBody(records)
    if(!prepared){await route.fulfill({response});return}
    const {body,first,chunks,count,changes}=prepared
    meta={...chunks[0]}; seq=meta.seq
    result.bootstraps.push({totalRows:count,rows:synthetic.length,originalRows:changes.length,fromSeq:first.seq,at:new Date().toISOString()}); save()
    seeded=true
    const headers={...response.headers(),'content-type':'application/x-ndjson'}
    for(const key of ['content-length','content-encoding','transfer-encoding']) delete headers[key]
    await route.fulfill({status:200,body,headers})
  })
  await context.route('**/trpc/discovery.refreshRepos*',async route=>{
    const response=await route.fetch(), json=await response.json()
    if(json.result?.data?.repositories) { json.result.data.repositories=[...corpus.repos,...json.result.data.repositories]; json.result.data.machines=[...corpus.machines,...(json.result.data.machines??[])] }
    await route.fulfill({response,json})
  })
  await context.routeWebSocket('**',client=>{
    result.socketUrls??=[];result.socketUrls.push(client.url())
    const upstream=client.connectToServer()
    const socket={client,upstream}; live.push(socket)
    client.onClose(()=>{const index=live.indexOf(socket);if(index>=0)live.splice(index,1);upstream.close()})
    upstream.onMessage(message=>{
      if(typeof message!=='string') return client.send(message)
      let frame; try{frame=JSON.parse(message)}catch{return client.send(message)}
      result.frameKinds??={};result.frameKinds[frame.type]=(result.frameKinds[frame.type]??0)+1
      const comparisonSession=id=>controls?.some(control=>control.session.sessionId===id || control.secondSession?.sessionId===id)
      for(const change of frame.changes??[])if(change.entity==='session' && comparisonSession(change.entityId))change.value.transcriptAvailable=true
      for(const session of frame.sessions??[])if(comparisonSession(session.sessionId))session.transcriptAvailable=true
      if(frame.type==='attached') outputEpochs.set(frame.sessionId,frame.epoch)
      if(frame.type==='outputFrame')traffic.outputFrames++
      if(frame.type==='machinesChanged') frame.machines=[...corpus.machines,...frame.machines]
      if(frame.type==='feedDelta' && seeded) {
        traffic.feedDeltas++
        for(const change of frame.changes)if(change.entity==='session' && controls?.some(control=>control.session.sessionId===change.entityId || control.secondSession?.sessionId===change.entityId))change.value.transcriptAvailable=true
        const size=Math.max(1,frame.seq-frame.fromSeq), start=seq
        seq+=size; frame={...frame,fromSeq:start,seq,changes:frame.changes.map((row,index)=>({...row,seq:start+index+1}))}
      }
      if(frame.type==='feedResume' && seeded) { /* reconnect is an explicit capture failure, not a hidden repair */ }
      client.send(JSON.stringify(frame))
    })
  })
}
function output(sessionId,text) {
  const epoch=outputEpochs.get(sessionId)
  if(epoch===undefined || !live.length)throw Error('Visible terminal has not attached; output would be ignored')
  const frame={type:'outputFrame',sessionId,epoch,seq:++outputSeq,data:Buffer.from(text).toString('base64')}
  for(const socket of live)socket.client.send(JSON.stringify(frame))
  traffic.syntheticOutput++
}
function push(entity, entityId, value) {
  pushChanges([{entity,entityId,value}])
}
function pushChanges(changes) {
  if(!meta || !live.length) throw Error('No initialized live feed')
  const fromSeq=seq
  const rows=changes.map(change=>({...change,seq:++seq,op:'upsert'}))
  const message={type:'feedDelta',feedId:meta.feedId,epoch:meta.epoch,minAvailableSeq:meta.minAvailableSeq,fromSeq,seq,changes:rows}
  for(const socket of live) socket.client.send(JSON.stringify(message))
}
async function makePage() {
  const context=await browser.newContext(surface==='phone'? {...devices['Pixel 7'],serviceWorkers:'block'}:{viewport:{width:1800,height:1000},reducedMotion:'reduce',serviceWorkers:'block'})
  await bindContext(context)
  const page=await context.newPage(); page.setDefaultTimeout(60000)
  // A newly spawned cross-site renderer can join global tracing after its
  // earliest initialization mark. Arm it on a neutral same-origin response;
  // the app's assets, storage and code remain untouched before cold navigation.
  const blank=`${base}/__benchmark_blank`
  await context.route(blank,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Benchmark preparation</title>'}))
  await page.goto(blank,{waitUntil:'domcontentloaded',timeout:120000})
  await context.unroute(blank)
  page.on('pageerror',error=>result.errors.push(error.message))
  page.on('console',message=>{if(['error','warning'].includes(message.type()))result.errors.push(`${message.type()}: ${message.text().slice(0,1000)}`)})
  await page.addInitScript(({now,surface})=>{
    const start=performance.now(); Date.now=()=>now+Math.floor(performance.now()-start)
    localStorage.setItem('podium.panelModeDefault','chat')
    localStorage.setItem('podium.panelMode','chat')
    window.__comparison=null
    const input=event=>{
      const capture=window.__comparison
      if(!capture || capture.input || !event.isTrusted) return
      capture.input=true
      performance.mark('comparison:input',{startTime:event.timeStamp})
    }
    for(const type of ['pointerdown','pointerup','keydown','beforeinput']) document.addEventListener(type,input,true)
    performance.mark('comparison:navigation-start',{startTime:0})
    window.__comparisonStartup=false
    const observeStartup=()=>{
      if(window.__comparisonStartup)return
      if(document.querySelector('[data-testid="boot-splash"]'))return
      const candidates=[...document.querySelectorAll(surface==='web'?'aside [data-issue-row]':'[role="button"][aria-label]')]
      const target=candidates.find(x=>{
        const label=x.getAttribute('aria-label')??'', rect=x.getBoundingClientRect()
        return (x.hasAttribute('data-issue-row') || /^(?:[A-Z]+-\d+|#\d+) /.test(label)) && rect.width>0 && rect.height>0 && rect.y>=0 && rect.bottom<=innerHeight
      })
      if(!target)return
      const rect=target.getBoundingClientRect(), x=Math.max(0,Math.min(innerWidth-1,rect.x+rect.width/2)), y=Math.max(0,Math.min(innerHeight-1,rect.y+rect.height/2))
      if(!target.contains(document.elementFromPoint(x,y)))return
      window.__comparisonStartup=true;performance.mark('comparison:startup-dom');startupObserver.disconnect()
    }
    const startupObserver=new MutationObserver(observeStartup)
    startupObserver.observe(document,{subtree:true,childList:true,attributes:true,characterData:true})
  },{now:corpus.fixedNow,surface})
  const cdp=await context.newCDPSession(page); await cdp.send('Performance.enable',{timeDomain:'threadTicks'})
  return {page,context,cdp}
}
const url=()=> (surface==='phone'?`${base}/mobile/work?server=${encodeURIComponent(relay)}&e2e=1`:`${base}/?server=${encodeURIComponent(relay)}&e2e=1`)+(activeQuery?'&'+activeQuery:'')
async function ready(page,{controlById=false}={}) {
  if(surface==='phone') {
    await page.waitForFunction(()=>!!document.querySelector('[aria-label="Search work"]') || document.body.innerText.includes('CANNOT START'),undefined,{timeout:120000})
    const failure=await page.evaluate(()=>document.body.innerText.includes('CANNOT START')?document.body.innerText.slice(0,700):null)
    if(failure)throw Error('Phone startup refused: '+failure)
  }
  else await page.locator('aside').first().waitFor({timeout:120000})
  if(controlById && surface==='web')await page.locator(`aside [data-issue-row="${controls[0].issue.id}"]`).first().waitFor({timeout:120000})
  else if(controlById)await page.getByText(/Comparison target A/).first().waitFor({timeout:120000})
  else await page.getByText('Comparison target A',{exact:true}).first().waitFor({timeout:120000})
  await page.evaluate(()=>document.fonts.ready); await frames(page); await pause(1200)
}
async function inspect(page,label) {
  const dom=await page.evaluate(()=>({url:location.href,buttons:[...document.querySelectorAll('button,[role="button"],[role="tab"]')].filter(x=>x.getClientRects().length).map(x=>({text:x.textContent?.trim().slice(0,140),label:x.getAttribute('aria-label'),title:x.getAttribute('title'),testid:x.getAttribute('data-testid'),issue:x.getAttribute('data-issue-row'),session:x.getAttribute('data-session'),html:x.outerHTML.slice(0,900)})),inputs:[...document.querySelectorAll('input,textarea,[contenteditable]')].filter(x=>x.getClientRects().length).map(x=>({placeholder:x.getAttribute('placeholder'),label:x.getAttribute('aria-label'),html:x.outerHTML.slice(0,900)})),rows:document.querySelectorAll('[data-issue-row],[data-issue-id]').length,text:document.body.innerText.slice(0,5000)}))
  writeFileSync(resolve(out,`${label}.json`),JSON.stringify(dom,null,2)); await page.screenshot({path:resolve(out,`${label}.png`)})
}
async function population(page) {
  const counts=await page.evaluate(async()=>{
    const counts={}
    for(const info of await indexedDB.databases()) {
      const db=await new Promise((yes,no)=>{const request=indexedDB.open(info.name);request.onsuccess=()=>yes(request.result);request.onerror=()=>no(request.error)})
      if(db.objectStoreNames.contains('entities'))await new Promise((yes,no)=>{
        const request=db.transaction('entities','readonly').objectStore('entities').getAll()
        request.onsuccess=()=>{for(const row of request.result)counts[row.entity]=(counts[row.entity]??0)+1;yes()};request.onerror=()=>no(request.error)
      })
      db.close()
    }
    return counts
  })
  result.population=counts;save()
  if(!controlOnly && (Math.max(counts.issue??0,counts.issueProjection??0)<corpus.issues.length || (counts.session??0)<corpus.sessions.length))throw Error('Full shared corpus did not reach durable client storage: '+JSON.stringify(counts))
}
let recordIndex=0
async function startup(fixture,name,profile=false) {
  const stop=await trace(fixture.cdp), before=await metrics(fixture.cdp), load=loadavg(), began=new Date().toISOString()
  if(profile){await fixture.cdp.send('Profiler.enable');await fixture.cdp.send('Profiler.setSamplingInterval',{interval:100});await fixture.cdp.send('Profiler.start')}
  await fixture.page.goto(url(),{waitUntil:'domcontentloaded',timeout:120000});await ready(fixture.page)
  const cpu=profile?(await fixture.cdp.send('Profiler.stop')).profile:null
  const events=await stop(), after=await metrics(fixture.cdp)
  const stem=`${name}-${recordIndex++}`
  writeFileSync(resolve(out,`${stem}.trace.json.gz`),gzipSync(JSON.stringify(events)))
  if(cpu)writeFileSync(resolve(out,`${stem}.cpuprofile`),JSON.stringify(cpu))
  result.startupMarks??=[]
  result.startupMarks.push({name,marks:events.filter(e=>e.name.startsWith('comparison:')).map(e=>({name:e.name,ph:e.ph,ts:e.ts,pid:e.pid}))});save()
  const measured=paintOf(events,'comparison:navigation-start','comparison:startup-dom')
  const input=events.find(x=>x.name==='comparison:navigation-start'), dom=events.find(x=>x.name==='comparison:startup-dom')
  const paint=events.filter(e=>e.name==='Paint' && e.ph==='X' && e.pid===input.pid && e.ts>=dom.ts).sort((a,b)=>a.ts-b.ts)[0]
  const end=paint.ts+(paint.dur??0)
  if(typeof input.tts!=='number' || typeof paint.tts!=='number' || typeof paint.tdur!=='number')throw Error('Startup CPU thread timestamps absent')
  const cpuEnd=paint.tts+paint.tdur
  const phaseMetrics=await fixture.page.evaluate(end => (window.__coldStartMetrics??[]).filter(entry=>entry.end<=end), measured.inputToPaintMs)
  const visibleRows=await fixture.page.evaluate(()=>[...document.querySelectorAll('aside [data-issue-row]')].filter(row=>{const r=row.getBoundingClientRect();return r.width>0&&r.height>0&&r.y>=0&&r.bottom<=innerHeight}).map(row=>({id:row.getAttribute('data-issue-row'),text:row.textContent})))
  result.actions.push({action:name,variant:activeVariant,query:activeQuery,phaseMetrics,visibleRows,startedAt:began,load,...measured,profiled:profile,mainThreadCpuMs:(cpuEnd-input.tts)/1000,layoutCpuMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.tts,cpuEnd,true),mainThreadBusyMs:intervalMs(events,['RunTask','ThreadControllerImpl::RunTask','ThreadControllerImpl::DoWork'],input.pid,paint.tid,input.ts,end),layoutMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.ts,end),taskWindowMs:(after.TaskDuration-before.TaskDuration)*1000,scriptWindowMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutWindowMs:(after.LayoutDuration-before.LayoutDuration)*1000,trace:`${stem}.trace.json.gz`,cpu:cpu?`${stem}.cpuprofile`:null})
  save(); console.log(`${name}: ${measured.inputToPaintMs.toFixed(1)} ms${profile?' (profile, excluded)':''}`)
}
try {
  for(let i=0;i<180;i++) { if(server.exitCode!==null) throw Error(`Harness exited ${server.exitCode}: ${serverLog.toString().slice(-2000)}`);try{if((await fetch(`${base}/health`)).ok)break}catch{};await pause(500) }
  const auth=await (await fetch(`${base}/auth/status`)).json();memberId=auth.memberId
  prepareExtras()
  let repoPath
  for(let attempt=0;attempt<120;attempt++) {
    const machines=await rpc('machines.list')
    if(machines.some(machine=>machine.inventory?.agents?.some(agent=>agent.kind==='claude-code' && agent.installed===true)))break
    if(attempt===119)throw Error('Harness agent inventory did not become ready')
    await pause(250)
  }
  for(let attempt=0;attempt<120;attempt++) {
    const repos=await rpc('repos.list')
    repoPath=repos.find(x=>x.includes('zz-podium-e2e-repo-'))??repos[0]
    if(repoPath)break
    if(attempt===119)throw Error('Harness repository did not become ready')
    await pause(250)
  }
  controls=[]
  for(const letter of ['A','B']) {
    const issue=await rpc('issues.create',{repoPath,title:`Comparison target ${letter}`,description:'Synthetic benchmark mission body',parentBranch:'main',startNow:true})
    await rpc('issues.update',{id:issue.id,patch:{stage:'in_progress',...(surface==='phone'?{pinned:true}:{})}})
    const session=await rpc('sessions.create',{cwd:repoPath,issueId:issue.id,agentKind:'claude-code',title:`Comparison session ${letter}`})
    controls.push({issue,session})
  }
  controls[0].secondSession=await rpc('sessions.create',{cwd:repoPath,issueId:controls[0].issue.id,agentKind:'claude-code',title:'Comparison session A2'})
  result.corpus.extraLiveSessions=(await rpc('sessions.list')).length
  result.controls=controls;save()
  // Validate the complete augmented wire stream before taking a capture lease.
  // Captured bootstrap delivery reuses serialized rows and changes only cursor
  // metadata, avoiding fixture schema-validation CPU in navigation timings.
  let canonical
  result.preflightAttempts=[]
  for(let attempt=0;attempt<120;attempt++) {
    const response=await fetch(`${base}/sync/bootstrap`), body=await response.text()
    writeFileSync(resolve(out,'canonical-preflight.ndjson'),body)
    if(!response.ok)throw Error(`Preflight bootstrap HTTP ${response.status}: ${body.slice(0,500)}`)
    canonical=body.trim().split('\n').map(line=>JSON.parse(line))
    const sessions=canonical.filter(row=>row.type==='feedBootstrap').flatMap(row=>row.changes).filter(row=>row.entity==='session')
    result.preflightAttempts.push({seq:canonical[0].seq,sessions:sessions.length,statuses:sessions.map(row=>row.value.status)})
    // Session creation returns before the daemon's spawn and sync publication.
    // Wait outside the capture lease for the same ready fixture in both arms.
    if(canonical[0].seq>=64 && controls.every(control=>sessions.some(row=>row.entityId===control.session.sessionId && row.value.status==='live')) && sessions.some(row=>row.entityId===controls[0].secondSession.sessionId && row.value.status==='live'))break
    if(attempt===119)throw Error('Comparison sessions did not become live in canonical sync')
    await pause(250)
  }
  const preflight=bootstrapBody(canonical)
  if(!preflight)throw Error('No canonical preflight snapshot')
  result.preflightSessions=preflight.changes.filter(row=>row.entity==='session').map(row=>({entityId:row.entityId,sessionId:row.value.sessionId,title:row.value.title,name:row.value.name,transcriptAvailable:row.value.transcriptAvailable,driverFamily:row.value.driverFamily,status:row.value.status}))
  async function* preflightLines(){yield* preflight.body.trim().split('\n')}
  for await(const record of readSyncStream(preflightLines())){/* complete production decoder */}
  result.preflightRows=preflight.count;save()
  browser=await chromium.launch({headless:true,executablePath:`${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,env:{...process.env,LD_LIBRARY_PATH:resolve('.toolchain/lib')},args:['--no-sandbox','--disable-dev-shm-usage']})
  result.browser=browser.version()
  const disk=statfsSync(out)
  result.diskCaptureStart={availableBytes:disk.bavail*disk.bsize}
  if(result.diskCaptureStart.availableBytes<512*1048576)throw Error('Less than 512 MiB available for capture evidence; no timing lease requested')
  if(process.argv.includes('--external-lease')) {
    console.log('CAPTURE_READY '+out)
    const file=resolve(out,'lease.json')
    while(!existsSync(file))await pause(100)
    result.lease=JSON.parse(readFileSync(file,'utf8'))
    const expected=mode==='timing'?'bench:flatblock':'meter:flatblock'
    if(result.lease.name!==expected || result.lease.host!=='ludovico')throw Error('Wrong capture lease')
  }
  result.captureStartedAt=new Date().toISOString();result.captureLoadStart=loadavg();result.hostCpuStart=cpuTicks()
  let f=fixture=await makePage()
  if(mode==='timing' && !backgroundOnly) {
    // Each cold sample owns a new browser context; the paired warm sample
    // reloads it, retaining durable rows and preferences. Bootstrap request
    // routing disables HTTP cache; this is a warm-data reload.
    for(let i=0;i<samples+1;i++) {
      if (paired) {
        const step = resolve(out,`step-${i}.go`)
        while (!existsSync(step)) await pause(100)
      }
      const order=variants.length ? [...variants.slice(i%variants.length),...variants.slice(0,i%variants.length)] : ['production']
      for(const variant of order) {
        activeVariant=variant
        activeQuery=variant==='production'?query:['coldStartTrace=1',variantQueries[variant],query].filter(Boolean).join('&')
        if(i!==0 || variant!==order[0])f=fixture=await makePage()
        await startup(f,'app-cold-start',i===samples)
        // First paint may precede eager cache durability. Verify every cold
        // snapshot before navigation can interrupt its native transaction.
        await population(f.page)
        result.actions.at(-1).population={...result.population};save()
        await startup(f,'app-warm-start',i===samples)
        await population(f.page)
        if(i!==samples || variant!==order.at(-1))await f.context.close()
      }
      if (paired) console.log('PAIR_STEP_FINISHED '+JSON.stringify({arm,step:i}))
    }
  }
  else {await f.page.goto(url(),{waitUntil:'domcontentloaded',timeout:120000});if(mode==='probe'){await pause(3000);await inspect(f.page,'early')}await ready(f.page)}
  if(!startupOnly)await inspect(f.page,'startup')
  await population(f.page)
  result.status='complete'
} catch(error) {
  result.status='failed';result.failure=String(error);console.error(error)
  if(fixture)await inspect(fixture.page,'failure').catch(()=>{})
} finally {
  result.endedAt=new Date().toISOString();result.loadEnd=loadavg();result.hostCpuEnd=cpuTicks();result.traffic=traffic
  try { save() } catch(error) { result.status='failed';result.failure=String(error);console.error('Evidence save failed',error) }
  console.log('CAPTURE_FINISHED '+result.status)
  await browser?.close().catch(error=>console.error('Browser cleanup failed',error))
  if(server.exitCode===null) {
    server.kill('SIGTERM')
    await Promise.race([new Promise(done=>server.once('exit',done)),pause(10000)])
    if(server.exitCode===null)server.kill('SIGKILL')
  }
  // The standard server boot regenerates this tracked declaration; it is type-only.
  if(declarationTracked)execFileSync('git',['restore','--source=HEAD','--','packages/api-types/src/index.d.ts'])
  try { save() } catch(error) { console.error('Final evidence save failed',error) }
}
  console.log(JSON.stringify({status:result.status,out,actions:result.actions.length,unavailable:result.unavailable.length,failure:result.failure}))
if(result.status==='failed')process.exitCode=1
