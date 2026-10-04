/** Foreground production app comparison. One implementation per invocation. */
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { hostname, cpus, loadavg } from 'node:os'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium, devices } from '@playwright/test'
import { paintOf } from './browser-paint.ts'
import * as model from '@podium/model'
import { readSyncStream } from '@podium/client-core/sync-stream'

const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const mode = arg('mode', 'probe'), scale = Number(arg('scale', '1')), surface = arg('surface', 'web')
const arm = arg('arm', ''), round = Number(arg('round', '0')), samples = Number(arg('samples', '8'))
if (hostname() !== 'flatblock' || (!process.argv.includes('--lease-confirmed') && !process.argv.includes('--external-lease'))) throw Error('flatblock with caller-owned bench (timing) or meter (probe/heap) lease required')
if (!['probe', 'timing', 'memory'].includes(mode) || !['web', 'phone'].includes(surface) || ![1,4].includes(scale) || !arm) throw Error('Invalid capture arguments')
const out = resolve(arg('out', `.artifacts/old-vs-new/${mode}-${arm}-${surface}-${scale}x-r${round}`))
mkdirSync(out, { recursive: true })
const corpusBytes = readFileSync(`.artifacts/old-vs-new/corpus-${scale}x.json`)
const corpus = JSON.parse(corpusBytes), synthetic = JSON.parse(readFileSync(`.artifacts/old-vs-new/rows-${scale}x.json`, 'utf8'))
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirtyProduct = execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages'], { encoding:'utf8' }).trim()
if (dirtyProduct === 'M packages/api-types/src/index.d.ts') execFileSync('git',['restore','--source=HEAD','--','packages/api-types/src/index.d.ts'])
else if (dirtyProduct) throw Error(`Product checkout is dirty: ${dirtyProduct}`)
const declarationTracked=execFileSync('git',['ls-files','packages/api-types/src/index.d.ts'],{encoding:'utf8'}).trim().length>0
const productDirectories = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages']
const productTreeSha256 = createHash('sha256').update(execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', ...productDirectories])).digest('hex')
const result = { version:1, mode, arm, round, surface, scale, sha, productTreeSha256,
  semanticSha256:createHash('sha256').update(corpusBytes).digest('hex'),
  corpus: { syntheticIssues:corpus.issues.length, syntheticSessions:corpus.sessions.length, extraLiveIssues:2, extraLiveSessions:2 },
  startedAt:new Date().toISOString(), host:hostname(), cpu:cpus()[0].model, cores:cpus().length,
  loadStart:loadavg(), actions:[], unavailable:[], background:[], errors:[], pids:[], bootstraps:[], status:'running' }
const save = () => writeFileSync(resolve(out, 'run.json'), JSON.stringify(result, null, 2)+'\n')
save()
const port = surface === 'web' ? 19551 : 19552
const base = `http://127.0.0.1:${port}`, relay = base.replace('http','ws')
const env = { ...process.env, PORT:String(port), PODIUM_NO_RELAY:'1' }
for (const key of Object.keys(env)) if (/^PODIUM_(SESSION|AGENT|CODEX_HOOK|ISSUE_RELAY|INSTANCE|HOME|STATE_DIR|AGENT_HOME|SERVER|PORT)/.test(key)) delete env[key]
const server = spawn(process.execPath, ['--conditions=@podium/source','tests/e2e/serve-harness.ts'], { cwd:process.cwd(), env, stdio:['ignore','pipe','pipe'] })
result.pids.push({ role:'harness', pid:server.pid })
const serverLog = []
for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog.push(data); writeFileSync(resolve(out,'server.log'), Buffer.concat(serverLog)) })
let browser
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
  await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline',transferMode:'ReportEvents'})
  return async () => {
    const completed = new Promise(done => cdp.once('Tracing.tracingComplete',done))
    await cdp.send('Tracing.end'); await completed; cdp.off('Tracing.dataCollected',collect); return events
  }
}
function intervalMs(events, names, pid, tid, begin, end) {
  const all = events.filter(e=>names.includes(e.name) && e.ph==='X' && e.pid===pid && (tid===undefined || e.tid===tid))
    .map(e=>[Math.max(begin,e.ts),Math.min(end,e.ts+(e.dur??0))]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0])
  const merged=[]
  for(const [a,b] of all) { const last=merged.at(-1); if(last && a<=last[1]) last[1]=Math.max(b,last[1]); else merged.push([a,b]) }
  return merged.reduce((sum,[a,b])=>sum+b-a,0)/1000
}
const live = []
const outputEpochs = new Map()
let outputSeq = 0
let meta, seq=0, memberId, controls, seeded=false
async function bindContext(context) {
  await context.route('**/sync/bootstrap*',async route=>{
    const response=await route.fetch(), records=(await response.text()).trim().split('\n').map(x=>JSON.parse(x))
    const first=records[0], complete=records.at(-1)
    if(first.type!=='syncMeta' || first.mode!=='snapshot') { await route.fulfill({response}); return }
    const chunks=records.filter(x=>x.type==='feedBootstrap')
    const changes=chunks.flatMap(x=>x.changes)
    const rows=synthetic.map(row=>{
      const value={...row.value}
      if(['issueUserState','sessionUserState'].includes(row.entity)) value.userId=memberId
      return {...row,value,entityId:['issueUserState','sessionUserState'].includes(row.entity)? (row.entity==='issueUserState'?model.issueUserStateRowId(memberId,value.entityId):model.sessionUserStateRowId(memberId,value.sessionId)):row.entityId}
    })
    const width=Math.min(256,first.seq)
    if(!width || !chunks.length) throw Error('Canonical bootstrap has no cursor/chunk')
    const extra=[]
    for(let offset=0;offset<rows.length;offset+=width) extra.push({...chunks[0],last:false,changes:rows.slice(offset,offset+width).map((row,index)=>({...row,seq:index+1,op:'upsert'}))})
    const all=[...chunks.map(x=>({...x,last:false})),...extra]
    all.at(-1).last=true
    const count=changes.length+rows.length
    for(const chunk of all) { chunk.totalRows=count; delete chunk.countsByEntity }
    const body=[{...first,totalRows:count},...all,{...complete,rows:count,records:all.length}].map(x=>JSON.stringify(x)).join('\n')+'\n'
    async function* lines(){yield* body.trim().split('\n')}
    for await(const record of readSyncStream(lines())) { /* same production decoder, full validation */ }
    meta={...chunks[0]}; seq=meta.seq
    result.bootstraps.push({totalRows:count,rows:rows.length,originalRows:changes.length,fromSeq:first.seq,at:new Date().toISOString()}); save()
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
  await context.routeWebSocket('**/client',client=>{
    const upstream=client.connectToServer()
    const socket={client,upstream}; live.push(socket)
    client.onClose(()=>{const index=live.indexOf(socket);if(index>=0)live.splice(index,1);upstream.close()})
    upstream.onMessage(message=>{
      if(typeof message!=='string') return client.send(message)
      let frame; try{frame=JSON.parse(message)}catch{return client.send(message)}
      if(frame.type==='attached') outputEpochs.set(frame.sessionId,frame.epoch)
      if(frame.type==='machinesChanged') frame.machines=[...corpus.machines,...frame.machines]
      if(frame.type==='feedDelta' && seeded) {
        const size=Math.max(1,frame.seq-frame.fromSeq), start=seq
        seq+=size; frame={...frame,fromSeq:start,seq,changes:frame.changes.map((row,index)=>({...row,seq:start+index+1}))}
      }
      if(frame.type==='feedResume' && seeded) { /* reconnect is an explicit capture failure, not a hidden repair */ }
      client.send(JSON.stringify(frame))
    })
  })
}
function push(entity, entityId, value) {
  if(!meta || !live.length) throw Error('No initialized live feed')
  const fromSeq=seq++
  const message={type:'feedDelta',feedId:meta.feedId,epoch:meta.epoch,minAvailableSeq:meta.minAvailableSeq,fromSeq,seq,changes:[{seq,entity,entityId,op:'upsert',value}]}
  for(const socket of live) socket.client.send(JSON.stringify(message))
}
async function makePage() {
  const context=await browser.newContext(surface==='phone'? {...devices['Pixel 7'],serviceWorkers:'block'}:{viewport:{width:1800,height:1000},reducedMotion:'reduce',serviceWorkers:'block'})
  await bindContext(context)
  const page=await context.newPage(); page.setDefaultTimeout(10000)
  page.on('pageerror',error=>result.errors.push(error.message))
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
    for(const type of ['pointerdown','keydown','beforeinput']) document.addEventListener(type,input,true)
    performance.mark('comparison:navigation-start',{startTime:0})
    window.__comparisonStartup=false
    const startupObserver=new MutationObserver(()=>{
      if(window.__comparisonStartup)return
      const target=[...document.querySelectorAll('button,[role="button"],[data-issue-row]')].find(x=>x.getClientRects().length && x.textContent?.includes('Comparison target A'))
      if(!target)return
      window.__comparisonStartup=true;performance.mark('comparison:startup-dom');startupObserver.disconnect()
    })
    startupObserver.observe(document,{subtree:true,childList:true,attributes:true,characterData:true})
  },{now:corpus.fixedNow})
  const cdp=await context.newCDPSession(page); await cdp.send('Performance.enable')
  return {page,context,cdp}
}
const url=()=>surface==='phone'?`${base}/mobile/work?server=${relay}`:`${base}/?server=${relay}&e2e=1`
async function ready(page) {
  if(surface==='phone') await page.getByRole('button',{name:'Search work',exact:true}).waitFor({timeout:120000})
  else await page.locator('aside').first().waitFor({timeout:120000})
  await page.getByText('Comparison target A',{exact:true}).first().waitFor({timeout:120000})
  await page.evaluate(()=>document.fonts.ready); await frames(page); await pause(1200)
}
async function inspect(page,label) {
  const dom=await page.evaluate(()=>({url:location.href,buttons:[...document.querySelectorAll('button,[role="button"],[role="tab"]')].filter(x=>x.getClientRects().length).map(x=>({text:x.textContent?.trim().slice(0,140),label:x.getAttribute('aria-label'),title:x.getAttribute('title'),testid:x.getAttribute('data-testid'),issue:x.getAttribute('data-issue-row'),session:x.getAttribute('data-session'),html:x.outerHTML.slice(0,900)})),inputs:[...document.querySelectorAll('input,textarea,[contenteditable]')].filter(x=>x.getClientRects().length).map(x=>({placeholder:x.getAttribute('placeholder'),label:x.getAttribute('aria-label'),html:x.outerHTML.slice(0,900)})),rows:document.querySelectorAll('[data-issue-row],[data-issue-id]').length,text:document.body.innerText.slice(0,5000)}))
  writeFileSync(resolve(out,`${label}.json`),JSON.stringify(dom,null,2)); await page.screenshot({path:resolve(out,`${label}.png`)})
}
async function attempt(name,fn) {
  try {await fn()} catch(error) {result.unavailable.push({action:name,reason:String(error),load:loadavg()}); console.log(`UNAVAILABLE ${name}: ${String(error).slice(0,240)}`); save()}
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
    if(manual){window.__comparison.input=true;performance.mark('comparison:input')}
    window.__comparison.observer=observer
  },{expectation,manual})
  const before=await metrics(cdp), stop=await trace(cdp)
  if(profile){await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:100});await cdp.send('Profiler.start')}
  const began=new Date().toISOString(), load=loadavg()
  let events, cpu
  try {await perform();await page.waitForFunction(()=>window.__comparison?.twoRaf,undefined,{timeout:20000})}
  finally {if(profile)cpu=(await cdp.send('Profiler.stop')).profile;events=await stop();await page.evaluate(()=>{window.__comparison?.observer?.disconnect();window.__comparison?.removeInput?.();window.__comparison=null})}
  const after=await metrics(cdp), measured=paintOf(events,'comparison:input','comparison:dom')
  const input=events.find(x=>x.name==='comparison:input'), dom=events.find(x=>x.name==='comparison:dom')
  const paint=events.filter(e=>e.name==='Paint' && e.ph==='X' && e.pid===input.pid && e.ts>=dom.ts).sort((a,b)=>a.ts-b.ts)[0]
  const end=paint.ts+(paint.dur??0), stem=`${String(recordIndex++).padStart(4,'0')}-${name}`
  writeFileSync(resolve(out,`${stem}.trace.json.gz`),gzipSync(JSON.stringify(events)))
  if(cpu)writeFileSync(resolve(out,`${stem}.cpuprofile`),JSON.stringify(cpu))
  const row={action:name,index:recordIndex-1,startedAt:began,load,...measured,profiled:profile,mainThreadBusyMs:intervalMs(events,['RunTask','ThreadControllerImpl::RunTask','ThreadControllerImpl::DoWork'],input.pid,paint.tid,input.ts,end),layoutMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.ts,end),scriptWindowMs:(after.ScriptDuration-before.ScriptDuration)*1000,taskWindowMs:(after.TaskDuration-before.TaskDuration)*1000,layoutWindowMs:(after.LayoutDuration-before.LayoutDuration)*1000,trace:`${stem}.trace.json.gz`,cpu:cpu?`${stem}.cpuprofile`:null}
  result.actions.push(row); save(); console.log(`${name}: ${measured.inputToPaintMs.toFixed(1)} ms`)
  return row
}
async function startup(fixture,name) {
  const stop=await trace(fixture.cdp), before=await metrics(fixture.cdp), load=loadavg(), began=new Date().toISOString()
  await fixture.page.goto(url(),{waitUntil:'domcontentloaded',timeout:120000});await ready(fixture.page)
  const events=await stop(), after=await metrics(fixture.cdp)
  const measured=paintOf(events,'comparison:navigation-start','comparison:startup-dom')
  const input=events.find(x=>x.name==='comparison:navigation-start'), dom=events.find(x=>x.name==='comparison:startup-dom')
  const paint=events.filter(e=>e.name==='Paint' && e.ph==='X' && e.pid===input.pid && e.ts>=dom.ts).sort((a,b)=>a.ts-b.ts)[0]
  const end=paint.ts+(paint.dur??0)
  result.actions.push({action:name,startedAt:began,load,...measured,profiled:false,mainThreadBusyMs:intervalMs(events,['RunTask','ThreadControllerImpl::RunTask','ThreadControllerImpl::DoWork'],input.pid,paint.tid,input.ts,end),layoutMs:intervalMs(events,['Layout','UpdateLayoutTree'],input.pid,paint.tid,input.ts,end),taskWindowMs:(after.TaskDuration-before.TaskDuration)*1000,scriptWindowMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutWindowMs:(after.LayoutDuration-before.LayoutDuration)*1000})
  writeFileSync(resolve(out,`${name}-${recordIndex++}.trace.json.gz`),gzipSync(JSON.stringify(events)));save()
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
      const collapsed=page.locator('aside button[aria-label^="Collapse "]').first()
      const label=await collapsed.getAttribute('aria-label'), expandedLabel=label.replace('Collapse ','Expand ')
      for(let i=0;i<samples+2;i++) {
        await capture(f,'sidebar-collapse',()=>page.getByRole('button',{name:label,exact:true}).click(),`aside button[aria-label="${expandedLabel}"]`)
        await capture(f,'sidebar-expand',()=>page.getByRole('button',{name:expandedLabel,exact:true}).click(),`aside button[aria-label="${label}"]`)
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
    await attempt('composer-typing',async()=>{
      const input=page.locator('[data-panel-resident][data-pane] textarea.prompt-input').last()
      await input.focus();await input.fill('')
      for(let i=0;i<samples+2;i++) {
        const wanted='x'.repeat(i+1)
        await capture(f,'composer-typing',()=>page.keyboard.insertText('x'),`() => [...document.querySelectorAll('[data-panel-resident][data-pane] textarea.prompt-input')].some(x=>x.value===${JSON.stringify(wanted)})`)
      }
      await input.fill('')
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
      await control().click({trial:true})
      for(let i=0;i<samples+2;i++) {
        const name=i%2?otherTitle:title
        const id=controls[i%2].session.sessionId
        await capture(f,'mission-switch',()=>page.locator(`aside [data-issue-row="${controls[i%2].issue.id}"]`).first().click(),`[data-flight-session="${id}"]`)
        await page.getByTestId('topbar-nav-issues').click();await page.getByRole('region',{name:'Tasks'}).waitFor()
      }
    })
    await attempt('command-palette',async()=>{
      for(let i=0;i<samples+2;i++) {
        await capture(f,'command-palette',()=>page.keyboard.press('Control+k'),'[role="dialog"]')
        await page.keyboard.press('Escape');await pause(100)
      }
    })
    await attempt('issue-board',async()=>{
      for(let i=0;i<samples+2;i++) {
        const home=page.getByTestId('topbar-nav-workspace')
        if(await home.count())await home.click()
        else await page.goto(url())
        await capture(f,'board-open',()=>page.getByTestId('topbar-nav-issues').click(),'[role="region"][aria-label="Tasks"]')
      }
    })
    await attempt('dock-open',async()=>{
      for(let i=0;i<samples+2;i++) {
        await page.getByTestId('topbar-nav-issues').click()
        await page.getByRole('textbox',{name:'Search tasks'}).fill(title)
        const close=page.locator('button[title^="Close "][title$=" panel"]')
        if(await close.count())await close.last().click()
        await capture(f,'dock-open',()=>page.locator('[data-issue-id]').filter({hasText:title}).first().click(),'[data-testid="dock-title"]')
        await close.last().click()
      }
    })
    await attempt('issue-rename',async()=>{
      await page.getByTestId('topbar-nav-issues').click()
      await page.getByRole('textbox',{name:'Search tasks'}).fill('Comparison')
      await page.locator('[data-issue-id]').filter({hasText:title}).first().click()
      for(let i=0;i<samples+2;i++) {
        const renamed=`Comparison target A revision ${i}`
        await page.getByTestId('dock-title').dblclick()
        await page.getByTestId('dock-inspect-head').locator('input').fill(renamed)
        await capture(f,'issue-rename',()=>page.keyboard.press('Enter'),`()=>document.querySelector('[data-testid="dock-title"]')?.textContent?.trim()===${JSON.stringify(renamed)}`)
      }
      await rpc('issues.update',{id:issue.id,patch:{title}})
    })
    await attempt('header-menu',async()=>{
      for(let i=0;i<samples+2;i++) {
        const trigger=page.locator('[data-testid="desktop-topbar"] button').filter({has:page.locator('svg')}).last()
        await capture(f,'header-menu',()=>trigger.click(),'[role="menu"]')
        await page.keyboard.press('Escape')
      }
    })
    await attempt('issue-page-open',async()=>{
      await page.getByTestId('topbar-nav-issues').click()
      const search=page.getByRole('textbox',{name:'Search tasks'})
      await search.fill(title);await pause(300)
      await inspect(page,'board')
      for(let i=0;i<samples+2;i++) {
        await capture(f,'issue-page-open',()=>page.locator('[data-issue-id]').filter({hasText:title}).first().click(),()=>!!document.querySelector('[data-testid="issue-page"]'))
        await page.getByTestId('topbar-nav-issues').click()
      }
    })
  } else {
    const work=()=>page.getByRole('tab',{name:'Work',exact:true})
    const tasks=()=>page.getByRole('tab',{name:'Tasks',exact:true})
    const target=()=>page.getByRole('button',{name:new RegExp(`^(?:[A-Z]+-\\d+|#\\d+) ${title}$`)})
    await attempt('phone-navigation',async()=>{
      for(let i=0;i<samples+2;i++) {
        await capture(f,'phone-issue-screen',()=>tasks().click(),()=>location.pathname==='/mobile/issues' && !!document.querySelector('[aria-label="New task"]'))
        await capture(f,'phone-work-screen',()=>work().click(),'[aria-label="Search work"]')
      }
    })
    await attempt('phone-mission-open',async()=>{
      await work().click()
      for(let i=0;i<samples+2;i++) {
        await capture(f,'phone-mission-open',()=>target().click(),'[aria-label="Mission actions"]')
        await work().click();await target().waitFor()
      }
    })
    await attempt('phone-inbox',async()=>{
      for(let i=0;i<samples+2;i++) {
        await capture(f,'phone-inbox',()=>page.getByRole('tab',{name:'Inbox',exact:true}).click(),()=>location.pathname.includes('/inbox'))
        await work().click()
      }
    })
    await attempt('phone-long-press',async()=>{
      await work().click()
      for(let i=0;i<samples+2;i++) {
        await target().click({trial:true});const box=await target().boundingBox()
        await capture(f,'phone-long-press',async()=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});await page.waitForTimeout(500)},()=>[...document.querySelectorAll('[role="button"],button')].some(x=>x.textContent?.trim()==='Rename'))
        await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]})
        await page.getByRole('button',{name:'Cancel',exact:true}).click().catch(()=>page.keyboard.press('Escape'))
      }
    })
  }
  await inspect(page,'after-actions')
}
async function background(f) {
  const heartbeat=synthetic.find(x=>x.entity==='session' && x.value.status==='live'), issue=synthetic.find(x=>x.entity==='issueProjection' && !x.value.closedAt)
  for(const [kind,row] of [['heartbeat',heartbeat],['issue-change',issue]]) {
    if(!row){result.unavailable.push({action:`background-${kind}`,reason:'No fixture target'});continue}
    for(let i=0;i<samples+2;i++) {
      const before=await metrics(f.cdp), load=loadavg()
      const value={...row.value,...(kind==='heartbeat'?{lastActiveAt:new Date(corpus.fixedNow+10000+i*1000).toISOString()}:{title:`Background issue revision ${i}`})}
      push(row.entity,row.entityId,value)
      await f.page.waitForTimeout(200);await frames(f.page)
      const after=await metrics(f.cdp)
      result.background.push({kind,load,taskMs:(after.TaskDuration-before.TaskDuration)*1000,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,count:1})
    }
  }
  const start=await metrics(f.cdp), load=loadavg(), began=Date.now(), delivered={heartbeat:0,issueChange:0}
  // Explicit synthetic cadence: one heartbeat/s and one issue change/5s.
  for(let second=0;second<60;second++) {
    if(heartbeat){push(heartbeat.entity,heartbeat.entityId,{...heartbeat.value,lastActiveAt:new Date(corpus.fixedNow+second*1000).toISOString()});delivered.heartbeat++}
    if(issue && second%5===0){push(issue.entity,issue.entityId,{...issue.value,title:`Live idle revision ${second}`});delivered.issueChange++}
    await pause(Math.max(0,began+(second+1)*1000-Date.now()))
  }
  const end=await metrics(f.cdp)
  result.idle={seconds:(Date.now()-began)/1000,loadStart:load,loadEnd:loadavg(),delivered,taskMs:(end.TaskDuration-start.TaskDuration)*1000,scriptMs:(end.ScriptDuration-start.ScriptDuration)*1000,layoutMs:(end.LayoutDuration-start.LayoutDuration)*1000}
  save()
}
try {
  for(let i=0;i<180;i++) { if(server.exitCode!==null) throw Error(`Harness exited ${server.exitCode}: ${Buffer.concat(serverLog).toString().slice(-2000)}`);try{if((await fetch(`${base}/health`)).ok)break}catch{};await pause(500) }
  const auth=await (await fetch(`${base}/auth/status`)).json();memberId=auth.memberId
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
    await rpc('issues.update',{id:issue.id,patch:{stage:'in_progress'}})
    const session=await rpc('sessions.create',{cwd:repoPath,issueId:issue.id,agentKind:'claude-code',title:`Comparison session ${letter}`})
    controls.push({issue,session})
  }
  controls[0].secondSession=await rpc('sessions.create',{cwd:repoPath,issueId:controls[0].issue.id,agentKind:'claude-code',title:'Comparison session A2'})
  result.corpus.extraLiveSessions=(await rpc('sessions.list')).length
  result.controls=controls;save()
  browser=await chromium.launch({headless:true,executablePath:`${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,env:{...process.env,LD_LIBRARY_PATH:resolve('.toolchain/lib')},args:['--no-sandbox','--disable-dev-shm-usage']})
  result.browser=browser.version()
  if(process.argv.includes('--external-lease')) {
    console.log('CAPTURE_READY '+out)
    const file=resolve(out,'lease.json')
    while(!existsSync(file))await pause(100)
    result.lease=JSON.parse(readFileSync(file,'utf8'))
    const expected=mode==='timing'?'bench:flatblock':'meter:flatblock'
    if(result.lease.name!==expected || result.lease.host!=='ludovico')throw Error('Wrong capture lease')
  }
  const f=await makePage()
  if(mode==='timing') {await startup(f,'app-cold-start');await startup(f,'app-warm-start')}
  else {await f.page.goto(url(),{waitUntil:'domcontentloaded',timeout:120000});await ready(f.page)}
  await inspect(f.page,'startup')
  if(mode==='probe') {
    // Untimed controls only: retain selectors for the complete timing action map.
    if(surface==='web'){await f.page.getByText('Comparison target A',{exact:true}).first().click();await pause(500);await inspect(f.page,'mission');await f.page.getByTestId('topbar-nav-issues').click();await f.page.getByRole('region',{name:'Tasks'}).waitFor({timeout:60000});await inspect(f.page,'board')}
    else {await f.page.getByRole('button',{name:'Search work',exact:true}).click();await inspect(f.page,'phone-search')}
  }
  if(mode==='timing'){await runActions(f);await background(f)}
  if(mode==='memory') {
    await f.cdp.send('HeapProfiler.collectGarbage');result.heapStartup=await f.cdp.send('Runtime.getHeapUsage');save()
    const began=Date.now(), loads=[]
    for(let i=0;i<60;i++) {
      loads.push(loadavg())
      if(surface==='phone'){await f.page.getByRole('tab',{name:i%2?'Work':'Tasks',exact:true}).click()}
      else {await f.page.getByTestId('topbar-nav-issues').click();await f.page.getByRole('textbox',{name:'Search tasks'}).fill(i%2?'Comparison':'')}
      await pause(Math.max(0,began+(i+1)*5000-Date.now()))
    }
    await f.cdp.send('HeapProfiler.collectGarbage');result.heapFiveMinutes=await f.cdp.send('Runtime.getHeapUsage');result.heapUse={durationSeconds:(Date.now()-began)/1000,actions:60,loads};save()
  }
  result.status='complete'
} catch(error) {
  result.status='failed';result.failure=String(error);console.error(error)
} finally {
  result.endedAt=new Date().toISOString();result.loadEnd=loadavg();save()
  console.log('CAPTURE_FINISHED '+result.status)
  await browser?.close()
  if(server.exitCode===null) {
    server.kill('SIGTERM')
    await Promise.race([new Promise(done=>server.once('exit',done)),pause(10000)])
    if(server.exitCode===null)server.kill('SIGKILL')
  }
  // The standard server boot regenerates this tracked declaration; it is type-only.
  if(declarationTracked)execFileSync('git',['restore','--source=HEAD','--','packages/api-types/src/index.d.ts'])
  save()
}
console.log(JSON.stringify({status:result.status,out,actions:result.actions.length,unavailable:result.unavailable.length}))
if(result.status==='failed')process.exitCode=1
