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
const controlOnly=process.argv.includes('--control-only')
const regionsOnly=process.argv.includes('--regions-only')
const worklistProbe=process.argv.includes('--worklist-probe')
const heartbeatOnly=regionsOnly || process.argv.includes('--heartbeat-only')
const backgroundOnly=heartbeatOnly || process.argv.includes('--background-only')
const terminalProbe=process.argv.includes('--terminal-probe')
const tasksProbe=process.argv.includes('--tasks-probe')
if (hostname() !== 'flatblock' || (!process.argv.includes('--lease-confirmed') && !process.argv.includes('--external-lease'))) throw Error('flatblock with caller-owned bench (timing) or meter (probe/heap) lease required')
if (!['probe', 'timing', 'memory'].includes(mode) || !['web', 'phone'].includes(surface) || ![1,4].includes(scale) || !arm) throw Error('Invalid capture arguments')
if(terminalProbe && (surface!=='phone' || mode!=='probe'))throw Error('Direct phone terminal is a structural probe, never a Work-screen timing capture')
if(tasksProbe && (surface!=='phone' || mode!=='probe' || terminalProbe))throw Error('Direct Tasks entry is a separate phone structural probe')
const out = resolve(arg('out', `.artifacts/old-vs-new/${mode}-${arm}-${surface}-${scale}x-r${round}`))
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
  httpCache:'disabled by bootstrap request routing',
  warmStartup:'Reload with retained durable data and preferences; snapshot responses augmented, delta/cursor-resume responses passed through',
  sameOriginTracePriming:true,
  semanticSha256:createHash('sha256').update(corpusBytes).digest('hex'),controlOnly,backgroundOnly,terminalProbe,tasksProbe,
  heartbeatOnly,
  regionsOnly,
  worklistProbe,
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
const port = surface === 'web' ? 19551 : 19552
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
    result.bootstrapResponses??=[]
    result.bootstrapResponses.push({at:new Date().toISOString(),mode:records[0]?.mode,augmented:!!prepared})
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
async function prepareObservedReplay() {
  const machines=[...corpus.machines,...await rpc('machines.list')]
  const heartbeat=synthetic.find(row=>row.entity==='session' && row.value.status==='live')
  const projection=synthetic.find(row=>row.entity==='issueProjection' && !row.value.closedAt)
  const legacy=synthetic.find(row=>row.entity==='issue' && row.entityId===projection.entityId)
  if(!heartbeat || !projection || !machines.length)throw Error('Observed-rate replay targets missing')
  const rates={heartbeat:12,issueChange:6,machine:16,conversation:28,hostMetrics:36,draft:2,sessionOutput:0}
  const jobs=[]
  for(const [kind,count] of Object.entries(rates))for(let index=0;index<count;index++) {
    const at=new Date(corpus.fixedNow+600000+index*1000).toISOString()
    let changes,frame
    if(kind==='heartbeat')changes=[{...heartbeat,value:{...heartbeat.value,lastActiveAt:at}}]
    if(kind==='issueChange')changes=[projection,...(legacy?[legacy]:[])].map(row=>({...row,value:{...row.value,title:`Observed issue revision ${index}`}}))
    if(kind==='conversation')changes=[{entity:'conversation',entityId:'comparison-observed-conversation',value:{id:'comparison-observed-conversation',agentKind:'claude-code',providerId:'claude-code',title:'Observed conversation fixture',createdAt:at,updatedAt:at,messageCount:index+1,sizeBytes:1024*(index+1)}}]
    if(kind==='machine')frame={type:'machinesChanged',machines:machines.map((machine,i)=>i===0?{...machine,lastSeenAt:at}:machine)}
    if(kind==='hostMetrics')frame={type:'hostMetricsChanged',hosts:[{hostname:'comparison-host',sampledAt:at,memory:{totalBytes:8589934592,availableBytes:4294967296,swapTotalBytes:0,swapFreeBytes:0}}]}
    if(kind==='draft')frame={type:'sessionDraftChanged',sessionId:controls[0].secondSession.sessionId,text:`Observed draft ${index}`,rev:index+1,origin:'comparison-replay',editedAt:at}
    // Schema parsing occurs before the lease, never in a measured window.
    if(changes)changes=changes.map((row,i)=>FeedChange.parse({...row,seq:i+1,op:'upsert'}))
    if(frame)frame=ServerMessage.parse(frame)
    jobs.push({kind,tick:Math.ceil((index+1)*120/count)-1,changes,frame})
  }
  observedReplay={source:'docs/measurements/POD-4286-baseline-summary.json: live connected-idle, 2026-09-18 (65.7874 s)',rates,jobs:jobs.sort((a,b)=>a.tick-b.tick)}
  result.observedReplayRecipe=observedReplay;save()
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
  await page.addInitScript(({now})=>{
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
      const candidates=[...document.querySelectorAll('aside [data-issue-row],[role="button"][aria-label]')]
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
  },{now:corpus.fixedNow})
  const cdp=await context.newCDPSession(page); await cdp.send('Performance.enable',{timeDomain:'threadTicks'})
  return {page,context,cdp}
}
const url=()=>surface==='phone'?`${base}/mobile/${terminalProbe?`session/${controls[0].secondSession.sessionId}/terminal`:tasksProbe?'issues':'work'}?server=${encodeURIComponent(relay)}&e2e=1`:`${base}/?server=${encodeURIComponent(relay)}&e2e=1`
async function ready(page,{controlById=false}={}) {
  if(surface==='phone') {
    await page.waitForFunction(selector=>!!document.querySelector(selector) || document.body.innerText.includes('CANNOT START'),terminalProbe?'.xterm':tasksProbe?'[aria-label="Search tasks"]':'[aria-label="Search work"]',{timeout:120000})
    const failure=await page.evaluate(()=>document.body.innerText.includes('CANNOT START')?document.body.innerText.slice(0,700):null)
    if(failure)throw Error('Phone startup refused: '+failure)
  }
  else await page.locator('aside').first().waitFor({timeout:120000})
  if(terminalProbe)await page.locator('.xterm').waitFor({timeout:120000})
  else if(tasksProbe) {
    const toggle=page.getByRole('button',{name:'Search tasks',exact:true})
    if(await toggle.isVisible().catch(()=>false))await toggle.click()
    await page.getByRole('textbox',{name:'Search tasks',exact:true}).fill('Comparison target A')
    await page.getByRole('button',{name:/^Task .*Comparison target A/}).first().waitFor({timeout:120000})
  }
  else if(controlById && surface==='web')await page.locator(`aside [data-issue-row="${controls[0].issue.id}"]`).first().waitFor({timeout:120000})
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
async function attempt(name,fn) {
  try {await fn()} catch(error) {
    result.unavailable.push({action:name,reason:String(error),load:loadavg()}); console.log(`UNAVAILABLE ${name}: ${String(error).slice(0,240)}`); save()
    if((round>=100 || name==='large-mission-switch') && fixture) {
      await inspect(fixture.page,`${name}-unavailable`).catch(()=>{})
      if(name==='large-mission-switch') {
        result.largeMissionFailureDom=await fixture.page.evaluate(()=>({url:location.href,headers:[...document.querySelectorAll('.deck-header')].map(x=>({text:x.textContent,width:x.getBoundingClientRect().width,hidden:!!x.closest('[aria-hidden="true"]')})),selected:[...document.querySelectorAll('[data-issue-row][data-selected="true"]')].map(x=>({id:x.getAttribute('data-issue-row'),text:x.textContent})),childRows:document.querySelectorAll('[data-testid="flight-deck-scroller"] [data-flight-issue]').length}))
        save()
      }
    }
    await fixture?.page.keyboard.press('Escape').catch(()=>{})
  }
}
let recordIndex=0
const actionSamples = new Map()
async function capture(fixture,name,perform,expected,{manual=false,profile=false}={}) {
  const {page,cdp}=fixture
  const ordinal=actionSamples.get(name)??0
  actionSamples.set(name,ordinal+1)
  profile ||= ordinal>=samples
  await frames(page)
  const expectation=typeof expected==='string'?expected:expected.toString()
  await page.evaluate(({expectation,manual})=>{
    const test=expectation.startsWith('(')||expectation.startsWith('function')?eval(`(${expectation})`):()=>!!document.querySelector(expectation)
    if(test()) throw Error('Expected effect is present before input; no-op forbidden')
    performance.clearMarks(); window.__comparison={input:false,ready:false}
    const observe=()=>{
      const c=window.__comparison
      if(!c?.input || c.ready || !test()) return
      c.ready=true; performance.mark('comparison:dom'); observer.disconnect()
      requestAnimationFrame(()=>requestAnimationFrame(()=>{c.twoRaf=true}))
    }
    const observer=new MutationObserver(observe)
    document.addEventListener('input',observe)
    window.__comparison.removeInput=()=>document.removeEventListener('input',observe)
    observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true})
    // History and compositor-only transitions can change the active route
    // without a DOM mutation. Poll that same semantic witness once per frame.
    const poll=()=>{if(!window.__comparison || window.__comparison.ready)return;observe();requestAnimationFrame(poll)}
    requestAnimationFrame(poll)
    if(manual){window.__comparison.input=true;performance.mark('comparison:input')}
    window.__comparison.observer=observer
  },{expectation,manual})
  const before=await metrics(cdp), stop=await trace(cdp)
  if(profile){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:100});await cdp.send('Profiler.start')}
  const began=new Date().toISOString(), load=loadavg()
  let events, cpu, captureFailure
  try {await perform();await page.waitForFunction(()=>window.__comparison?.twoRaf,undefined,{timeout:20000})}
  catch(error){captureFailure=error}
  finally {if(profile)cpu=(await cdp.send('Profiler.stop')).profile;events=await stop();await page.evaluate(()=>{window.__comparison?.observer?.disconnect();window.__comparison?.removeInput?.();window.__comparison=null})}
  const after=await metrics(cdp)
  const stem=`${String(recordIndex++).padStart(4,'0')}-${name}`
  writeFileSync(resolve(out,`${stem}.trace.json.gz`),gzipSync(JSON.stringify(events)))
  if(cpu)writeFileSync(resolve(out,`${stem}.cpuprofile`),JSON.stringify(cpu))
  if(captureFailure) {
    result.failedActions??=[]
    result.failedActions.push({action:name,startedAt:began,load,profiled:profile,expectation,reason:String(captureFailure),trace:`${stem}.trace.json.gz`,cpu:cpu?`${stem}.cpuprofile`:null})
    save();throw captureFailure
  }
  let measured, boundary='Paint'
  try{measured=paintOf(events,'comparison:input','comparison:dom')}catch(error){
    if(!['phone-work-screen','phone-issue-screen'].includes(name) || !String(error).includes('No actual Chromium Paint'))throw error
    const input=events.find(x=>x.name==='comparison:input'), dom=events.find(x=>x.name==='comparison:dom')
    const drawn=events.filter(x=>['DrawFrame','FramePresented'].includes(x.name) && x.ts>=dom.ts && x.pid===input.pid).sort((a,b)=>a.ts-b.ts)[0]
    if(!drawn)throw Error('No qualifying compositor frame after active Work screen; see retained trace')
    boundary=drawn.name+' (compositor, no new raster Paint)'
    measured={inputToPaintMs:(drawn.ts+(drawn.dur??0)-input.ts)/1000,selectedDomMs:(dom.ts-input.ts)/1000}
  }
  const input=events.find(x=>x.name==='comparison:input'), dom=events.find(x=>x.name==='comparison:dom')
  const paint=events.filter(e=>e.name==='Paint' && e.ph==='X' && e.pid===input.pid && e.ts>=dom.ts).sort((a,b)=>a.ts-b.ts)[0]
  if(!paint){
    const row={action:name,index:recordIndex-1,startedAt:began,load,...measured,boundary,profiled:profile,mainThreadCpuMs:null,layoutCpuMs:null,mainThreadBusyMs:null,layoutMs:null,taskWindowMs:(after.TaskDuration-before.TaskDuration)*1000,scriptWindowMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutWindowMs:(after.LayoutDuration-before.LayoutDuration)*1000,trace:`${stem}.trace.json.gz`,cpu:cpu?`${stem}.cpuprofile`:null}
    result.actions.push(row);save();console.log(`${name}: ${measured.inputToPaintMs.toFixed(1)} ms (${boundary})`);return row
  }
  const end=paint.ts+(paint.dur??0)
  if(typeof input.tts!=='number' || typeof paint.tts!=='number' || typeof paint.tdur!=='number')throw Error('CPU thread timestamps absent; no hardware CPU claim permitted')
  const cpuEnd=paint.tts+paint.tdur
  writeFileSync(resolve(out,`${stem}.trace.json.gz`),gzipSync(JSON.stringify(events)))
  if(cpu)writeFileSync(resolve(out,`${stem}.cpuprofile`),JSON.stringify(cpu))
  const row={action:name,index:recordIndex-1,startedAt:began,load,...measured,boundary,profiled:profile,mainThreadCpuMs:(cpuEnd-input.tts)/1000,layoutCpuMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.tts,cpuEnd,true),mainThreadBusyMs:intervalMs(events,['RunTask','ThreadControllerImpl::RunTask','ThreadControllerImpl::DoWork'],input.pid,paint.tid,input.ts,end),layoutMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.ts,end),scriptWindowMs:(after.ScriptDuration-before.ScriptDuration)*1000,taskWindowMs:(after.TaskDuration-before.TaskDuration)*1000,layoutWindowMs:(after.LayoutDuration-before.LayoutDuration)*1000,trace:`${stem}.trace.json.gz`,cpu:cpu?`${stem}.cpuprofile`:null}
  result.actions.push(row); save(); console.log(`${name}: ${measured.inputToPaintMs.toFixed(1)} ms`)
  return row
}
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
  result.actions.push({action:name,startedAt:began,load,...measured,profiled:profile,mainThreadCpuMs:(cpuEnd-input.tts)/1000,layoutCpuMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.tts,cpuEnd,true),mainThreadBusyMs:intervalMs(events,['RunTask','ThreadControllerImpl::RunTask','ThreadControllerImpl::DoWork'],input.pid,paint.tid,input.ts,end),layoutMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.ts,end),taskWindowMs:(after.TaskDuration-before.TaskDuration)*1000,scriptWindowMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutWindowMs:(after.LayoutDuration-before.LayoutDuration)*1000,trace:`${stem}.trace.json.gz`,cpu:cpu?`${stem}.cpuprofile`:null})
  save()
}
async function runActions(f) {
  const {page,cdp}=f
  const issue=controls[0].issue, other=controls[1].issue
  const title='Comparison target A', otherTitle='Comparison target B'
  if(surface==='web') {
    const row = id => page.locator(`aside [data-issue-row="${id}"]`).first()
    await attempt('sidebar-select',async()=>{
      await page.getByTestId('topbar-nav-workspace').click()
      await row(controls[1].issue.id).click()
      for(let i=0;i<samples+2;i++) {
        const id=controls[i%2].issue.id
        await capture(f,'sidebar-select',()=>row(id).click(),`aside [data-issue-row="${id}"][data-selected="true"]`)
      }
    })
    await attempt('sidebar-fold',async()=>{
      const label='Collapse sidebar', expandedLabel='Expand sidebar'
      for(let i=0;i<samples+2;i++) {
        await capture(f,'sidebar-collapse',()=>page.getByRole('button',{name:label,exact:true}).click(),`button[aria-label="${expandedLabel}"]`)
        await capture(f,'sidebar-expand',()=>page.getByRole('button',{name:expandedLabel,exact:true}).click(),`button[aria-label="${label}"]`)
      }
    })
    await attempt('sidebar-group-fold',async()=>{
      const ids=corpus.issues.filter(issue=>issue.repoId===groupCorpusRepoId).map(issue=>issue.id)
      const target=await page.evaluate(ids=>{
        const wanted=new Set(ids),groups=[...document.querySelectorAll('aside [data-testid="project-group"]')]
        for(let index=0;index<groups.length;index++) {
          const rows=[...groups[index].querySelectorAll('[data-issue-row]')],anchor=rows.find(row=>wanted.has(row.getAttribute('data-issue-row')))
          if(anchor)return {index,anchorIssueId:anchor.getAttribute('data-issue-row'),initialRows:rows.length,label:groups[index].querySelector('[data-testid="project-group-label"]')?.textContent}
        }
        throw Error('No populated corpus project group')
      },ids)
      result.sidebarGroupTarget=target;save()
      const group=page.locator('aside [data-testid="project-group"]').nth(target.index)
      const button=group.getByTestId('project-group-label')
      if(await button.getAttribute('data-collapsed')==='true')await button.click()
      await button.scrollIntoViewIfNeeded()
      for(let i=0;i<samples+2;i++) {
        await capture(f,'sidebar-group-collapse',()=>button.click(),`()=>document.querySelectorAll('aside [data-testid="project-group"]')[${target.index}]?.getAttribute('data-collapsed')==='true'`)
        await capture(f,'sidebar-group-expand',()=>button.click(),`()=>document.querySelectorAll('aside [data-testid="project-group"]')[${target.index}]?.getAttribute('data-collapsed')==='false'`)
      }
    })
    await attempt('session-switch',async()=>{
      await row(issue.id).click()
      const expand=page.getByRole('button',{name:'Expand Flight Deck',exact:true})
      if(await expand.isVisible().catch(()=>false))await expand.click()
      const ids=[controls[0].session.sessionId,controls[0].secondSession.sessionId]
      const agent=id=>page.locator(`[data-flight-session="${id}"] button.deck-agent`).first()
      await agent(ids[1]).click()
      for(let i=0;i<samples+2;i++) {
        const id=ids[i%2]
        await capture(f,'session-switch',()=>agent(id).click(),`[data-panel-resident][data-session="${id}"][data-pane]`)
      }
      await inspect(page,'session')
    })
    await attempt('session-composer-typing',async()=>{
      const chat=page.locator('[data-panel-resident][data-pane] [data-testid="mode-chat"]').last()
      await chat.click({timeout:10000})
      const input=page.locator('[data-panel-resident][data-pane] textarea.prompt-input').last()
      await input.focus();await input.fill('')
      for(let i=0;i<samples+2;i++) {
        const wanted='x'.repeat(i+1)
        await capture(f,'session-composer-typing',()=>page.keyboard.insertText('x'),`() => [...document.querySelectorAll('[data-panel-resident][data-pane] textarea.prompt-input')].some(x=>x.value===${JSON.stringify(wanted)})`)
      }
      await input.fill('')
    })
    await attempt('superagent-composer-typing',async()=>{
      const trigger=page.getByTestId('right-rail').getByRole('button',{name:'Superagent',exact:true})
      if(await trigger.getAttribute('aria-pressed')!=='true')await trigger.click()
      const input=page.getByPlaceholder('Ask across all tasks…')
      await input.focus();await input.fill('')
      for(let i=0;i<samples+2;i++)await capture(f,'superagent-composer-typing',()=>page.keyboard.insertText('x'),`()=>[...document.querySelectorAll('textarea')].some(x=>x.placeholder==='Ask across all tasks…' && x.value===${JSON.stringify('x'.repeat(i+1))})`)
      await input.fill('');await trigger.click()
    })
    await attempt('flight-deck-fold',async()=>{
      const collapse=page.getByRole('button',{name:'Collapse Flight Deck',exact:true}), expand=page.getByRole('button',{name:'Expand Flight Deck',exact:true})
      if(await expand.isVisible().catch(()=>false))await expand.click()
      for(let i=0;i<samples+2;i++){
        await capture(f,'flight-deck-collapse',()=>collapse.click(),'button[aria-label="Expand Flight Deck"]')
        await capture(f,'flight-deck-expand',()=>expand.click(),'button[aria-label="Collapse Flight Deck"]')
      }
    })
    await attempt('drag',async()=>{
      const grip=row(other.id).getByTestId('row-grip')
      for(let i=0;i<samples+2;i++) {
        await row(other.id).hover();const box=await grip.boundingBox()
        if(!box)throw Error('No sidebar reorder grip')
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
        try {
          await capture(f,'sidebar-drag-start',async()=>{await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height/2+20)},`()=> [...document.querySelectorAll('[data-drag-key]')].some(x=>x.style.zIndex!=='' && x.style.pointerEvents==='none')`)
        } finally {await page.keyboard.press('Escape');await page.mouse.up()}
      }
    })
    await attempt('sidebar-drag-drop',async()=>{
      for(let i=0;i<samples+2;i++) {
        await row(other.id).hover()
        const grip=row(other.id).getByTestId('row-grip'), from=await grip.boundingBox(), target=await row(issue.id).boundingBox()
        if(!from || !target || target.y<0 || target.y+target.height>1000)throw Error('Both control rows must be visible for a comparable drag drop')
        const before=await page.evaluate(({a,b})=>!!(document.querySelector(`aside [data-issue-row="${a}"]`).compareDocumentPosition(document.querySelector(`aside [data-issue-row="${b}"]`))&Node.DOCUMENT_POSITION_FOLLOWING),{a:issue.id,b:other.id})
        await page.mouse.move(from.x+from.width/2,from.y+from.height/2)
        await page.mouse.down()
        await page.mouse.move(from.x+from.width/2,before?target.y+4:target.y+target.height-4,{steps:5})
        await pause(150)
        try {
          await capture(f,'sidebar-drag-drop',()=>page.mouse.up(),`()=>{const a=document.querySelector('aside [data-issue-row="${issue.id}"]'),b=document.querySelector('aside [data-issue-row="${other.id}"]');return !!a && !!b && (!!(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING))!==${before} && b.closest('[data-drag-key]').style.pointerEvents!=='none'}`)
        } finally {await page.keyboard.press('Escape');await page.mouse.up()}
      }
    })
    await attempt('mark-read',async()=>{
      await row(issue.id).click()
      for(let i=0;i<samples+2;i++) {
        await rpc('issues.markUnread',{id:other.id})
        await page.waitForFunction(id=>document.querySelector(`aside [data-issue-row="${id}"]`)?.textContent.includes('unread'),other.id)
        await row(other.id).click({button:'right'})
        const menu=page.getByRole('menuitem',{name:/^Mark (?:as )?read/i})
        await menu.waitFor()
        await capture(f,'mark-read',()=>menu.click(),`()=>!document.querySelector('aside [data-issue-row="${other.id}"]')?.textContent.includes('unread')`)
      }
    })
    const control=()=>page.getByText(title,{exact:true}).first()
    await attempt('mission-open',async()=>{
      await page.getByTestId('topbar-nav-issues').click();await page.getByRole('region',{name:'Tasks'}).waitFor()
      await control().click({trial:true})
      for(let i=0;i<samples+2;i++) {
        const name=i%2?otherTitle:title
        const id=controls[i%2].session.sessionId
        await capture(f,'mission-switch',()=>page.locator(`aside [data-issue-row="${controls[i%2].issue.id}"]`).first().click(),`[data-flight-session="${id}"]`)
        await page.getByTestId('topbar-nav-issues').click();await page.getByRole('region',{name:'Tasks'}).waitFor()
      }
    })
    await attempt('large-mission-switch',async()=>{
      for(let i=0;i<samples+2;i++) {
        await page.getByTestId('topbar-nav-issues').click()
        const target=largeMissionTargets[i%2]
        await row(target.id).scrollIntoViewIfNeeded()
        // The mission root is a header; data-flight-issue labels its children.
        const measured=await capture(f,'large-mission-switch',()=>row(target.id).click(),`()=>[...document.querySelectorAll('.deck-header')].some(header=>header.textContent?.includes(${JSON.stringify(target.title)}) && header.getBoundingClientRect().width>0 && !header.closest('[aria-hidden="true"]')) && !!document.querySelector('[data-testid="flight-deck-scroller"] [data-flight-issue]')`)
        measured.targetIssueId=target.id
        measured.deckIssueRows=await page.locator('[data-testid="flight-deck-scroller"] [data-flight-issue]').count()
        measured.deckSessionRows=await page.locator('[data-testid="flight-deck-scroller"] [data-flight-session]').count();save()
      }
    })
    await attempt('command-palette',async()=>{
      for(let i=0;i<samples+2;i++) {
        await capture(f,'command-palette',()=>page.keyboard.press('Control+k'),'[role="dialog"]')
        await page.keyboard.press('Escape');await pause(100)
      }
    })
    await attempt('issue-picker-search',async()=>{
      await page.keyboard.press('Control+k')
      const input=page.getByRole('combobox')
      await input.fill(otherTitle);await pause(300)
      for(let i=0;i<samples+2;i++) {
        const wanted=i%2?otherTitle:title, unwanted=i%2?title:otherTitle
        await capture(f,'issue-picker-search',()=>input.fill(wanted),`()=>document.querySelector('[role="combobox"]')?.value===${JSON.stringify(wanted)} && document.querySelector('[role="listbox"]')?.textContent?.includes(${JSON.stringify(wanted)}) && !document.querySelector('[role="listbox"]')?.textContent?.includes(${JSON.stringify(unwanted)})`)
      }
      await page.keyboard.press('Escape');await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Command palette'}).waitFor({state:'hidden'})
    })
    await attempt('issue-board',async()=>{
      for(let i=0;i<samples+2;i++) {
        const back=page.locator('[data-testid="issue-page"] button[title="Back"]')
        if(await back.isVisible().catch(()=>false))await back.click()
        const home=page.getByTestId('topbar-nav-workspace')
        if(await home.count())await home.click()
        else await page.goto(url())
        await capture(f,'board-open',()=>page.getByTestId('topbar-nav-issues').click(),()=>location.pathname==='/issues' && !!document.querySelector('[aria-label="Search tasks"]'))
      }
    })
    await attempt('dock-open',async()=>{
      await page.getByTestId('topbar-nav-workspace').click();await row(issue.id).click()
      const close=page.locator('button[title^="Close "][title$=" panel"]')
      if(await close.count())await close.last().click()
      for(let i=0;i<samples+2;i++) {
        await capture(f,'dock-open',()=>page.getByTestId('right-rail').getByRole('button',{name:'Tasks',exact:true}).click(),'[data-right-dock-panel="issue"]')
        await capture(f,'dock-close',()=>page.locator('button[title="Close tasks panel"]').click(),()=>!document.querySelector('[data-right-dock-panel="issue"]'))
      }
    })
    await attempt('issue-rename',async()=>{
      await page.getByTestId('topbar-nav-workspace').click()
      for(let i=0;i<samples+2;i++) {
        const renamed=`Comparison target A revision ${i}`
        await row(issue.id).locator('.shell-work-row-title').dblclick()
        await row(issue.id).locator('input').fill(renamed)
        await capture(f,'issue-rename',()=>page.keyboard.press('Enter'),`()=>document.querySelector('aside [data-issue-row="${issue.id}"] .shell-work-row-title')?.textContent?.trim()===${JSON.stringify(renamed)}`)
      }
      await rpc('issues.update',{id:issue.id,patch:{title}})
    })
    await attempt('header-menu',async()=>{
      await row(issue.id).click()
      for(let i=0;i<samples+2;i++) {
        const trigger=page.locator('[data-panel-resident][data-pane] [data-testid="header-menu"]').last()
        await capture(f,'header-menu',()=>trigger.click(),'[role="menu"]')
        await trigger.click();await page.getByRole('menu').waitFor({state:'hidden'})
      }
    })
    await attempt('issue-page-open',async()=>{
      await page.getByTestId('topbar-nav-issues').click()
      const search=page.getByRole('textbox',{name:'Search tasks'})
      await search.fill(title);await pause(300)
      await inspect(page,'board')
      for(let i=0;i<samples+2;i++) {
        await capture(f,'issue-page-open',()=>page.locator('[data-issue-id]').filter({hasText:title}).first().click(),()=>!!document.querySelector('[data-testid="issue-page"]'))
        await page.locator('[data-testid="issue-page"] button[title="Back"]').click()
      }
    })
    await attempt('board-search',async()=>{
      await page.getByTestId('topbar-nav-issues').click()
      const input=page.getByRole('textbox',{name:'Search tasks'})
      await input.fill('unflake');await pause(300)
      for(let i=0;i<samples+2;i++){
        const wanted=i%2?'unflake':'Comparison', unwanted=i%2?'Comparison':'unflake'
        await capture(f,'board-search',()=>input.fill(wanted),`()=>document.querySelector('[aria-label="Search tasks"]')?.value===${JSON.stringify(wanted)} && [...document.querySelectorAll('[data-issue-id]')].some(x=>x.textContent?.includes(${JSON.stringify(wanted)})) && ![...document.querySelectorAll('[data-issue-id]')].some(x=>x.textContent?.includes(${JSON.stringify(unwanted)}))`)
      }
    })
  } else {
    const work=()=>page.getByRole('tab',{name:'Work',exact:true})
    const tasks=()=>page.getByRole('tab',{name:'Tasks',exact:true})
    const backToTabs=async()=>{
      for(let i=0;i<4 && !await work().isVisible().catch(()=>false);i++) {
        const done=page.getByRole('button',{name:'Done',exact:true})
        if(await done.isVisible().catch(()=>false))await done.click()
        else await page.getByRole('button',{name:'Back',exact:true}).click()
      }
    }
    const toWork=async()=>{await backToTabs();await work().click()}
    const toTasks=async()=>{await backToTabs();await tasks().click()}
    const target=()=>page.getByRole('button',{name:new RegExp(`^(?:[A-Z]+-\\d+|#\\d+) ${title}$`)})
    await attempt('phone-navigation',async()=>{
      for(let i=0;i<samples+2;i++) {
        await capture(f,'phone-issue-screen',()=>tasks().click(),()=>location.pathname==='/mobile/issues' && !!document.querySelector('[aria-label="Search tasks"]'))
        await capture(f,'phone-work-screen',()=>work().click(),()=>location.pathname==='/mobile/work' && document.querySelector('[role="tab"][aria-label="Work"]')?.getAttribute('aria-selected')==='true')
      }
    })
    await attempt('phone-mission-open',async()=>{
      await toWork()
      for(let i=0;i<samples+2;i++) {
        await capture(f,'phone-mission-open',()=>target().click(),'[aria-label="Mission actions"]')
        await toWork();await target().waitFor()
      }
    })
    await attempt('phone-inbox',async()=>{
      if(!await page.getByRole('tab',{name:'Inbox',exact:true}).count())throw Error('No Inbox tab or production route in this revision; detached Inbox component is not a whole-app measurement')
      for(let i=0;i<samples+2;i++) {
        await capture(f,'phone-inbox',()=>page.getByRole('tab',{name:'Inbox',exact:true}).click(),()=>location.pathname.includes('/inbox'))
        await toWork()
      }
    })
    await attempt('phone-long-press',async()=>{
      await toWork()
      for(let i=0;i<samples+2;i++) {
        await target().click({trial:true});const box=await target().boundingBox()
        await capture(f,'phone-long-press',async()=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});await page.waitForTimeout(500)},()=>[...document.querySelectorAll('[role="button"],button')].some(x=>x.textContent?.trim()==='Rename'))
        await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]})
        await page.getByRole('button',{name:'Cancel',exact:true}).click().catch(()=>page.keyboard.press('Escape'))
      }
    })
    await attempt('phone-mission-details',async()=>{
      await toWork();await target().click()
      for(let i=0;i<samples+2;i++){
        await capture(f,'phone-mission-details',()=>page.getByRole('button',{name:'Mission details',exact:true}).click(),()=>location.pathname.endsWith('/details') && !!document.querySelector('[aria-label="Launch an agent on this mission"]'))
        await page.getByRole('button',{name:'Done',exact:true}).click()
      }
    })
    await attempt('phone-composer-typing',async()=>{
      await toWork();await target().click()
      const input=page.locator('textarea').last()
      await input.focus();await input.fill('')
      for(let i=0;i<samples+2;i++)await capture(f,'phone-composer-typing',()=>page.keyboard.insertText('x'),`()=>[...document.querySelectorAll('textarea')].some(x=>x.value===${JSON.stringify('x'.repeat(i+1))})`)
      await input.fill('')
    })
    await attempt('phone-issue-open',async()=>{
      await toTasks()
      const searchToggle=page.getByRole('button',{name:'Search tasks',exact:true})
      if(await searchToggle.isVisible().catch(()=>false))await searchToggle.click()
      const input=page.getByRole('textbox',{name:'Search tasks',exact:true})
      await input.fill(title);await pause(250)
      await inspect(page,'phone-board')
      const task=()=>page.getByRole('button',{name:new RegExp(`^Task .*${title}`)}).first()
      for(let i=0;i<samples+2;i++) {
        await capture(f,'phone-issue-open',()=>task().click(),`()=>location.pathname==='/mobile/issue/${issue.id}' && !!document.querySelector('[data-testid="issue-keyboard-avoider"]')`)
        await page.getByRole('button',{name:'Back',exact:true}).click()
      }
      await task().click();await inspect(page,'phone-issue')
    })
    await attempt('phone-issue-picker',async()=>{
      const details=page.getByRole('button',{name:'Details',exact:true})
      if(await details.count() && !await page.getByRole('button',{name:'Set parent',exact:true}).count())await details.click()
      await page.getByRole('button',{name:'Set parent',exact:true}).click()
      const input=page.getByRole('textbox',{name:'Search parent',exact:true})
      const alternative=corpus.issues.find(row=>!row.parentId && !row.closedAt && !row.archived).title
      await input.fill(alternative);await pause(350)
      for(let i=0;i<samples+2;i++){
        const wanted=i%2?alternative:otherTitle, unwanted=i%2?otherTitle:alternative
        await capture(f,'phone-issue-picker-search',()=>input.fill(wanted),`()=>{const input=document.querySelector('[aria-label="Search parent"]');const scope=input?.closest('[aria-modal="true"],[role="dialog"]');const labels=[...(scope?.querySelectorAll('[role="button"]')??[])].map(x=>x.getAttribute('aria-label'));return input?.value===${JSON.stringify(wanted)} && labels.some(x=>x?.endsWith(${JSON.stringify(wanted)})) && !labels.some(x=>x?.endsWith(${JSON.stringify(unwanted)}))}`)
      }
      const cancel=page.getByRole('button',{name:'Cancel',exact:true})
      if(await cancel.isVisible().catch(()=>false))await cancel.click()
      else await page.keyboard.press('Escape')
    })
    await attempt('phone-issue-rename',async()=>{
      for(let i=0;i<samples+2;i++){
        const renamed=`Comparison target A revision ${i}`
        await page.getByRole('button',{name:'Task title — edit',exact:true}).click()
        await page.getByRole('textbox',{name:'Task title',exact:true}).fill(renamed)
        await capture(f,'phone-issue-rename',()=>page.getByRole('button',{name:'Save',exact:true}).click(),`()=>[...document.querySelectorAll('[role="button"]')].some(x=>x.getAttribute('aria-label')==='Task title — edit' && x.textContent?.trim()===${JSON.stringify(renamed)})`)
      }
      await rpc('issues.update',{id:issue.id,patch:{title}})
    })
    await attempt('phone-search',async()=>{
      await toWork();await page.getByRole('button',{name:'Search work',exact:true}).click()
      const input=page.getByRole('textbox',{name:'Search work',exact:true})
      await input.fill(otherTitle);await pause(300)
      for(let i=0;i<samples+2;i++){
        const wanted=i%2?otherTitle:title
        await capture(f,'phone-work-search',()=>input.fill(wanted),`()=>document.querySelector('[aria-label="Search work"][role="textbox"],input[aria-label="Search work"]')?.value===${JSON.stringify(wanted)} && [...document.querySelectorAll('[role="button"]')].filter(x=>!x.closest('[aria-hidden="true"]')).some(x=>x.getAttribute('aria-label')?.endsWith(${JSON.stringify(wanted)})) && ![...document.querySelectorAll('[role="button"]')].filter(x=>!x.closest('[aria-hidden="true"]')).some(x=>x.getAttribute('aria-label')?.endsWith(${JSON.stringify(i%2?title:otherTitle)}))`)
      }
      await page.getByRole('button',{name:'Close search',exact:true}).click()
    })
  }
  await inspect(page,'after-actions')
}
async function background(f) {
  const heartbeat=synthetic.find(x=>x.entity==='session' && x.value.status==='live'), issue=synthetic.find(x=>x.entity==='issueProjection' && !x.value.closedAt)
  const legacyIssue=synthetic.find(x=>x.entity==='issue' && x.entityId===issue.entityId)
  const issueChanges=value=>[
    ...(legacyIssue?[{...legacyIssue,value:{...legacyIssue.value,title:value.title}}]:[]),
    {...issue,value}
  ]
  result.issueUpdateEntities=issueChanges(issue.value).map(row=>row.entity);save()
  const targetSession=controls[0].secondSession.sessionId
  await attempt('background-output-setup',async()=>{
    if(surface==='web') {
      await f.page.getByTestId('topbar-nav-workspace').click()
      await f.page.locator(`aside [data-issue-row="${controls[0].issue.id}"]`).first().click()
      const expand=f.page.getByRole('button',{name:'Expand Flight Deck',exact:true})
      if(await expand.isVisible().catch(()=>false))await expand.click()
      await f.page.locator(`[data-flight-session="${targetSession}"] button.deck-agent`).first().click()
      const native=f.page.locator('[data-panel-resident][data-pane] [data-testid="mode-native"]').last()
      if(await native.count())await native.click()
      await f.page.locator('[data-panel-resident][data-pane] .xterm').waitFor()
    } else {
      await f.page.goto(`${base}/mobile/session/${targetSession}/terminal?server=${encodeURIComponent(relay)}&e2e=1`,{waitUntil:'domcontentloaded'})
      await f.page.locator('.xterm').waitFor({timeout:30000})
    }
    for(let i=0;i<100 && !outputEpochs.has(targetSession);i++)await pause(100)
    if(!outputEpochs.has(targetSession))throw Error('No output subscription on visible comparison terminal')
    await pause(1000)
    output(targetSession,'comparison delivery witness\r\n')
    await f.page.waitForFunction(()=>window.__podium?.screenText?.().includes('comparison delivery witness'),undefined,{timeout:15000})
    result.outputDeliveryWitness=true;save()
  })
  const outputAvailable=outputEpochs.has(targetSession)
  if(heartbeatOnly) {
    result.backgroundDom=await f.page.evaluate(()=>{
      const countNodes=root=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_ALL);let count=1;while(walker.nextNode())count++;return count}
      const region=(name,root)=>{
        const rect=root.getBoundingClientRect(),style=getComputedStyle(root)
        return {name,nodes:countNodes(root),elements:root.querySelectorAll('*').length+1,
          hidden:style.display==='none'||style.visibility==='hidden'||rect.width===0||rect.height===0,
          offscreen:rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth,
          rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
          issueRows:root.querySelectorAll('[data-issue-row]').length,
          flightSessions:root.querySelectorAll('[data-flight-session]').length}
      }
      const regions=[]
      for(const [name,selector] of [['sidebar','aside'],['flightDeck','[data-flight-deck-shell]'],['agentPanel','[data-panel-resident]'],['header','[data-testid="desktop-topbar"]']])
        for(const [index,root] of [...document.querySelectorAll(selector)].entries())regions.push(region(`${name}:${index}`,root))
      return {connectedNodes:countNodes(document),connectedElements:document.querySelectorAll('*').length,regions}
    })
    save()
  }
  if(regionsOnly) {
    if(worklistProbe) {
      const page=f.page, scroll=page.getByTestId('work-scroll')
      const counts=await page.locator('[data-window-count]').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.windowCount)))
      const count=Math.max(...counts)
      const window=page.locator(`[data-window-count="${count}"]`).first()
      await window.scrollIntoViewIfNeeded(); await frames(page); await frames(page)
      const key=await window.locator('[data-window-row]').evaluateAll(nodes=>{
        const scroll=document.querySelector('[data-testid="work-scroll"]').getBoundingClientRect()
        return nodes.find(node=>{const r=node.getBoundingClientRect();return r.top>=scroll.top&&r.bottom<=scroll.bottom})?.dataset.windowRow
      })
      if(!key)throw Error('No visible row in largest sidebar window')
      await window.locator(`[data-window-row="${key}"] button`).first().focus()
      await page.keyboard.press('End'); await frames(page); await frames(page)
      const end=await page.evaluate(()=>{const row=document.activeElement?.closest('[data-window-row]');return {index:Number(row?.getAttribute('aria-posinset')),size:Number(row?.getAttribute('aria-setsize'))}})
      if(end.index!==count||end.size!==count)throw Error('Sidebar End did not reach the last row')
      await page.keyboard.press('Home'); await frames(page); await frames(page)
      const home=await page.evaluate(()=>Number(document.activeElement?.closest('[data-window-row]')?.getAttribute('aria-posinset')))
      if(home!==1)throw Error('Sidebar Home did not reveal the first row')
      // Exercise native pointer capture and edge auto-scroll, then cancel before
      // a write: the synthetic corpus is intentionally absent from server truth.
      const grip=window.getByTestId('row-grip').first()
      await grip.scrollIntoViewIfNeeded()
      const sourceKey=await grip.evaluate(node=>node.closest('[data-window-row]').dataset.windowRow)
      const box=await grip.boundingBox(), viewport=await scroll.boundingBox()
      const before=await scroll.evaluate(node=>node.scrollTop)
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down()
      await page.mouse.move(viewport.x+20,viewport.y+viewport.height-2)
      await page.waitForTimeout(450)
      const during=await page.evaluate(sourceKey=>({top:document.querySelector('[data-testid="work-scroll"]').scrollTop,retained:!!document.querySelector(`[data-window-row="${sourceKey}"]`),rows:document.querySelectorAll('[data-window-row]').length}),sourceKey)
      await page.keyboard.press('Escape'); await page.mouse.up(); await frames(page)
      if(during.top<=before||!during.retained)throw Error('Sidebar drag did not auto-scroll with its source retained')
      result.worklistProbe={keyboardEnd:end,keyboardHome:home,dragAutoScroll:{before,...during},largestGroup:count}
      await page.screenshot({path:resolve(out,'worklist-window.png')})
      save()
    }
    return
  }
  const metricWindow=async(kind,perform,profiled=false)=>{
    const before=await metrics(f.cdp), load=loadavg(), stop=await trace(f.cdp)
    if(profiled){await f.cdp.send('Profiler.enable');await f.cdp.send('Profiler.setSamplingInterval',{interval:100});await f.cdp.send('Profiler.start')}
    await perform();await pause(200);await frames(f.page)
    const cpu=profiled?(await f.cdp.send('Profiler.stop')).profile:null
    const after=await metrics(f.cdp), events=await stop()
    const index=result.background.length, name=`background-${index}-${kind}.trace.json.gz`
    writeFileSync(resolve(out,name),gzipSync(JSON.stringify(events)))
    const cpuName=cpu?`background-${index}-${kind}.cpuprofile`:null
    if(cpu)writeFileSync(resolve(out,cpuName),JSON.stringify(cpu))
    const row={kind,load,taskMs:(after.TaskDuration-before.TaskDuration)*1000,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,count:kind==='quiet'?0:1,nominalWindowMs:200,actualWindowMs:(after.Timestamp-before.Timestamp)*1000,trace:name,...(heartbeatOnly?{profiled,cpu:cpuName}:{})}
    result.background.push(row);save()
    return row
  }
  for(let i=0;i<samples;i++)await metricWindow('quiet',async()=>{})
  for(const [kind,row] of (heartbeatOnly?[['heartbeat',heartbeat]]:[['heartbeat',heartbeat],['issue-change',issue]])) {
    if(!row){result.unavailable.push({action:`background-${kind}`,reason:'No fixture target'});continue}
    for(let i=0;i<samples+2;i++) {
      const value={...row.value,...(kind==='heartbeat'?{lastActiveAt:new Date(corpus.fixedNow+10000+i*1000).toISOString()}:{title:`Background issue revision ${i}`})}
      await metricWindow(kind,async()=>kind==='issue-change'?pushChanges(issueChanges(value)):push(row.entity,row.entityId,value),heartbeatOnly && i>=samples)
    }
  }
  if(heartbeatOnly)return
  if(outputAvailable)for(let i=0;i<samples+2;i++)await metricWindow('session-output',async()=>output(targetSession,`comparison output ${i}\r\n`))
  // Approximate the historical operator publication rates, using synthetic
  // payloads. Host/draft/conversation events were not output frames; do not
  // silently substitute terminal activity for them.
  const observedStart=await metrics(f.cdp), observedLoad=loadavg(), observedBegan=Date.now(), observedDelivered=Object.fromEntries(Object.keys(observedReplay.rates).map(kind=>[kind,0]))
  for(let tick=0;tick<120;tick++) {
    for(const job of observedReplay.jobs.filter(job=>job.tick===tick)) {
      if(job.changes)pushChanges(job.changes)
      else for(const socket of live)socket.client.send(JSON.stringify(job.frame))
      observedDelivered[job.kind]++
    }
    await pause(Math.max(0,observedBegan+(tick+1)*500-Date.now()))
  }
  const observedEnd=await metrics(f.cdp)
  result.idleProfiles={observed:{seconds:(Date.now()-observedBegan)/1000,loadStart:observedLoad,loadEnd:loadavg(),delivered:observedDelivered,taskMs:(observedEnd.TaskDuration-observedStart.TaskDuration)*1000,scriptMs:(observedEnd.ScriptDuration-observedStart.ScriptDuration)*1000,layoutMs:(observedEnd.LayoutDuration-observedStart.LayoutDuration)*1000}}
  save()
  const start=await metrics(f.cdp), load=loadavg(), began=Date.now(), delivered={heartbeat:0,issueChange:0,sessionOutput:0}, upstreamStart={...traffic}
  // Activity-window replay: 30 heartbeats/min and 10 issue changes/min;
  // output is an explicitly synthetic assumption of two terminal frames/sec.
  for(let tick=0;tick<120;tick++) {
    if(heartbeat && tick%4===0){push(heartbeat.entity,heartbeat.entityId,{...heartbeat.value,lastActiveAt:new Date(corpus.fixedNow+720000+tick*500).toISOString()});delivered.heartbeat++;traffic.syntheticHeartbeat++}
    if(issue && tick%12===0){pushChanges(issueChanges({...issue.value,title:`Live idle revision ${tick}`}));delivered.issueChange++;traffic.syntheticIssue++}
    if(outputAvailable){output(targetSession,`operator output frame ${tick}\r\n`);delivered.sessionOutput++}
    await pause(Math.max(0,began+(tick+1)*500-Date.now()))
  }
  const end=await metrics(f.cdp)
  result.idle={seconds:(Date.now()-began)/1000,loadStart:load,loadEnd:loadavg(),delivered,upstreamStart,upstreamEnd:{...traffic},taskMs:(end.TaskDuration-start.TaskDuration)*1000,scriptMs:(end.ScriptDuration-start.ScriptDuration)*1000,layoutMs:(end.LayoutDuration-start.LayoutDuration)*1000}
  result.idleProfiles.busy=result.idle
  save()
}
try {
  for(let i=0;i<180;i++) { if(server.exitCode!==null) throw Error(`Harness exited ${server.exitCode}: ${serverLog.toString().slice(-2000)}`);try{if((await fetch(`${base}/health`)).ok)break}catch{};await pause(500) }
  const auth=await (await fetch(`${base}/auth/status`)).json();memberId=auth.memberId
  prepareExtras()
  const repos=await rpc('repos.list'),repoPath=repos.find(x=>x.includes('zz-podium-e2e-repo-'))??repos[0]
  for(let attempt=0;attempt<120;attempt++) {
    const machines=await rpc('machines.list')
    if(machines.some(machine=>machine.inventory?.agents?.some(agent=>agent.kind==='claude-code' && agent.installed===true)))break
    if(attempt===119)throw Error('Harness agent inventory did not become ready')
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
  if(mode==='timing')await prepareObservedReplay()
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
    for(let i=0;i<5;i++) {
      if(i!==0)f=fixture=await makePage()
      await startup(f,'app-cold-start',i===4);await startup(f,'app-warm-start',i===4)
      if(i!==4)await f.context.close()
    }
  }
  else {await f.page.goto(url(),{waitUntil:'domcontentloaded',timeout:120000});if(mode==='probe'){await pause(3000);await inspect(f.page,'early')}await ready(f.page)}
  await inspect(f.page,'startup')
  await population(f.page)
  if(mode==='probe') {
    // Untimed controls only: retain selectors for the complete timing action map.
    if(surface==='web'){await f.page.getByText('Comparison target A',{exact:true}).first().click();await pause(500);await inspect(f.page,'mission');await f.page.getByTestId('topbar-nav-issues').click();await f.page.getByRole('region',{name:'Tasks'}).waitFor({timeout:60000});await inspect(f.page,'board')}
    else if(terminalProbe) {
      const targetSession=controls[0].secondSession.sessionId
      for(let i=0;i<100 && !outputEpochs.has(targetSession);i++)await pause(100)
      if(!outputEpochs.has(targetSession))throw Error('No output subscription on direct phone terminal')
      output(targetSession,'comparison direct-terminal witness\r\n')
      await f.page.waitForFunction(()=>window.__podium?.screenText?.().includes('comparison direct-terminal witness'),undefined,{timeout:15000})
      result.directTerminalWitness={sessionId:targetSession,subscription:true,renderedOutput:true};save()
      await inspect(f.page,'phone-terminal')
    }
    else if(tasksProbe) {
      await f.page.getByRole('button',{name:/^Task .*Comparison target A/}).first().click()
      await f.page.getByTestId('issue-keyboard-avoider').waitFor({timeout:60000})
      result.directTasksWitness={taskRow:true,issueScreen:true};save()
      await inspect(f.page,'phone-direct-issue')
    }
    else {await f.page.getByRole('button',{name:'Search work',exact:true}).click();await inspect(f.page,'phone-search')}
  }
  if(mode==='timing') {
    if(!backgroundOnly) {
      await runActions(f)
      result.actionPhaseComplete=true;save()
      // Optimistic rename can finish before its final server publication. Reset
      // after the whole action phase, and identify the control by its stable ID.
      for(const [index,control] of controls.entries())await rpc('issues.update',{id:control.issue.id,patch:{title:`Comparison target ${index?'B':'A'}`}})
      // A failed/unavailable action must not leave one arm with extra resident
      // panes when comparing background updates. Match the initial UI state.
      await f.context.close();f=fixture=await makePage()
      await f.page.goto(url(),{waitUntil:'domcontentloaded',timeout:120000});await ready(f.page,{controlById:true});await population(f.page)
    }
    result.backgroundContext='Fresh browser profile; same visible control terminal and corpus, no resident panes from preceding action cases';save()
    await background(f)
  }
  if(mode==='memory') {
    await f.cdp.send('HeapProfiler.collectGarbage');result.heapStartup=await f.cdp.send('Runtime.getHeapUsage');save()
    const began=Date.now(), loads=[], steps=[]
    const page=f.page, issue=controls[0].issue, title='Comparison target A'
    const step=async(i)=>{
      if(surface==='web') {
        if(i%3===0) {
          await page.getByTestId('topbar-nav-workspace').click()
          await page.locator(`aside [data-issue-row="${issue.id}"]`).first().click()
          const expand=page.getByRole('button',{name:'Expand Flight Deck',exact:true})
          if(await expand.isVisible().catch(()=>false))await expand.click()
          const id=i%2?controls[0].session.sessionId:controls[0].secondSession.sessionId
          await page.locator(`[data-flight-session="${id}"] button.deck-agent`).first().click()
          return 'mission and session switch'
        }
        if(i%3===1) {
          await page.getByTestId('topbar-nav-issues').click()
          await page.getByRole('textbox',{name:'Search tasks'}).fill(title)
          await page.locator('[data-issue-id]').filter({hasText:title}).first().click()
          await page.locator('[data-testid="issue-page"] button[title="Back"]').click()
          return 'board search and issue page'
        }
        await page.keyboard.press('Control+k')
        await page.getByRole('combobox').fill(title)
        await page.keyboard.press('Escape');await page.keyboard.press('Escape')
        await page.getByTestId('topbar-nav-workspace').click()
        const trigger=page.getByTestId('right-rail').getByRole('button',{name:'Superagent',exact:true})
        if(await trigger.getAttribute('aria-pressed')!=='true')await trigger.click()
        const input=page.getByPlaceholder('Ask across all tasks…')
        await input.fill('five minute comparison draft');await input.fill('')
        await trigger.click()
        return 'palette search and composer draft'
      }
      const work=page.getByRole('tab',{name:'Work',exact:true})
      if(i%2===0) {
        await work.click()
        await page.getByRole('button',{name:new RegExp(`^(?:[A-Z]+-\\d+|#\\d+) ${title}$`)}).click()
        await page.getByRole('button',{name:'Mission details',exact:true}).click()
        await page.getByRole('button',{name:'Done',exact:true}).click()
        await page.getByRole('button',{name:'Back',exact:true}).click()
        return 'work mission and details'
      }
      await page.getByRole('tab',{name:'Tasks',exact:true}).click()
      const searchToggle=page.getByRole('button',{name:'Search tasks',exact:true})
      if(await searchToggle.isVisible().catch(()=>false))await searchToggle.click()
      await page.getByRole('textbox',{name:'Search tasks',exact:true}).fill(title)
      await page.getByRole('button',{name:new RegExp(`^Task .*${title}`)}).first().click()
      await page.getByRole('button',{name:'Back',exact:true}).click()
      return 'task search and issue page'
    }
    // Keep the observation at five minutes even if OLD cannot keep up with
    // the five-second cadence. Finish an in-flight group; report its overrun.
    for(let i=0;i<60 && Date.now()<began+300000;i++) {
      loads.push(loadavg());const started=Date.now()
      steps.push({step:i,kind:await step(i),durationMs:Date.now()-started})
      await frames(page)
      await pause(Math.max(0,Math.min(began+300000,began+(i+1)*5000)-Date.now()))
    }
    await f.cdp.send('HeapProfiler.collectGarbage');result.heapFiveMinutes=await f.cdp.send('Runtime.getHeapUsage');result.heapUse={durationSeconds:(Date.now()-began)/1000,steps:steps.length,actions:steps.length,workload:'Five-minute wall-clock workload, at most 60 action groups at five-second cadence; an in-flight group can overrun the deadline. See actual duration and steps.',loads,stepsCompleted:steps};save()
  }
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
