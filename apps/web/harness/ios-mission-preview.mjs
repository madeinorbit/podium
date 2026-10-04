/** Isolated production preview of POD-5508's validated synthetic corpus.
 * Run on the Mac from the issue-owned directory. No upstream or operator RPC.
 * ablation.txt can contain "no-mark" for a diagnostic-only overlay ablation.
 */
import { appendFileSync } from 'node:fs'
const root = process.env.IOS_PREVIEW_ROOT
if (!root) throw Error('Set IOS_PREVIEW_ROOT to the owned runner directory')
const mobileRoot = `${root}/dist-${process.env.IOS_MOBILE_ARM ?? 'mobile'}`
const manifest = await Bun.file(`${root}/manifest.json`).json()
const api = await Bun.file(`${root}/fixture-api.json`).json()
const transcript = await Bun.file(`${root}/transcript.json`).json()
const streamMode = process.env.IOS_STREAM === '1'
const streamSeconds = Number(process.env.IOS_STREAM_SECONDS ?? 180)
const sessionId = manifest.control
const template = structuredClone(transcript)
const fixedNow = manifest.fixedNow ?? 1789905600000
const workingBootstrap = new Map()
let generation = 0
let nextItem = transcript.length
function copyTurn() {
  const turn = template.slice(0,11)
  const prefix = `ios-live-${++generation}-`
  return turn.map(item=> {
    const copy = structuredClone(item)
    copy.id = `synthetic-${nextItem++}`
    copy.cursor = copy.id
    copy.ts = new Date(Date.now()).toISOString()
    // Tool ids in the generated template are unique per turn too.
    for (const key of ['text','raw','toolUseId','toolInput','toolResult']) if (typeof copy[key] === 'string') {
      copy[key] = copy[key].replace(/tool-[a-z0-9-]+/g,id=>prefix+id)
    }
    return copy
  })
}
if (streamMode) while (transcript.length < 33_000) transcript.push(...copyTurn())
const subscribers = new Set()
let streamDeadline = null
let liveTurn = null
const streamTimer = streamMode ? setInterval(()=> {
  if (subscribers.size === 0) return
  if (streamDeadline === null) streamDeadline = Date.now() + streamSeconds * 1_000
  if (Date.now() >= streamDeadline) return
  const settled = liveTurn ? [{...liveTurn.at(-1),answer:true}] : []
  if (settled.length) transcript[transcript.length-1]=settled[0]
  const items = copyTurn()
  items[items.length-1].answer=false
  liveTurn=items
  transcript.push(...items)
  for (const client of subscribers) client.send(JSON.stringify({type:'transcriptDelta',sessionId,
    items:[...settled,...items],tail:items.at(-1)?.cursor}))
},250) : null
const progressTimer = streamMode ? setInterval(()=> {
  if (!liveTurn || !streamDeadline || Date.now() >= streamDeadline || subscribers.size === 0) return
  const previous=liveTurn.at(-1)
  const item={...previous,text:previous.text+'\nStreaming the generated verification result.',answer:false}
  liveTurn[liveTurn.length-1]=item
  transcript[transcript.length-1]=item
  for(const client of subscribers) client.send(JSON.stringify({type:'transcriptDelta',sessionId,
    items:[item],tail:item.cursor}))
},100) : null
const frames = await Bun.file(`${root}/socket-frames.json`).json()
const procedures = new Map()
for (const [path, entry] of Object.entries(api)) {
  if (!path.startsWith('/trpc/')) continue
  const names = new URL(path, 'http://fixture').pathname.slice(6).split(',')
  const values = JSON.parse(entry.body)
  names.forEach((name, index) => procedures.set(name, Array.isArray(values) ? values[index] : values))
}
function readTranscript(input = {}) {
  const limit = input.limit ?? 200
  let index = input.anchor ? transcript.findIndex(item => item.cursor === input.anchor) : transcript.length
  if (index < 0) index = transcript.length
  const items = input.direction === 'after' && input.anchor
    ? transcript.slice(index + 1, index + 1 + limit)
    : transcript.slice(Math.max(0, index - limit), index)
  return { result: { data: { items, head: items[0]?.cursor, tail: items.at(-1)?.cursor, hasMore: index > limit } } }
}
const telemetry = `<script>
  localStorage.setItem('podium.panelMode','chat');
  localStorage.setItem('podium.panelModeDefault','chat');
  window.__fixtureErrors=[];
  window.__fixtureRetainAll=new URL(location.href).searchParams.has('retainAll');
  const workerCounts=window.__fixtureWorkerCounts={posted:0,completed:0,pending:0,maxPending:0,clonedItems:0,maxItems:0};
  if(typeof Worker==='function') {
    const NativeWorker=Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.fixturePending=new Set();
        this.addEventListener('message',event=>{
          if(this.fixturePending.delete(event.data?.id)) {workerCounts.pending--;workerCounts.completed++;}
        });
      }
      postMessage(message,...args) {
        if(message?.kind==='index'||message?.kind==='delta'||message?.kind==='search') {
          this.fixturePending.add(message.id);workerCounts.posted++;workerCounts.pending++;
          workerCounts.maxPending=Math.max(workerCounts.maxPending,workerCounts.pending);
          const size=message.input?.items?.length??message.changed?.length??0;
          workerCounts.clonedItems+=size;workerCounts.maxItems=Math.max(workerCounts.maxItems,size);
        }
        return super.postMessage(message,...args);
      }
    };
  }
  const boot=crypto.randomUUID();
  function diag(extra={}) {
    fetch('/__diag',{method:'POST',body:JSON.stringify({boot,age:performance.now(),
      url:location.href,nodes:document.getElementsByTagName('*').length,
      rows:document.querySelectorAll('[data-block]').length,
      marks:document.querySelectorAll('[data-testid="working-mark"]').length,
      svg:document.querySelectorAll('svg').length,
      circles:document.querySelectorAll('circle').length,
      canvases:Array.from(document.querySelectorAll('canvas')).map(c=>[c.width,c.height]),
      images:document.images.length,errors:window.__fixtureErrors,
      retained:window.__fixtureTranscriptCounts??null,worker:workerCounts,
      scroll:Array.from(document.querySelectorAll('[data-testid="transcript-scroller"]')).map(s=>({top:s.scrollTop,height:s.scrollHeight,viewport:s.clientHeight})),
      rowPaint:Array.from(document.querySelectorAll('[data-block]')).slice(-4).map(row=>{
        const box=row.getBoundingClientRect(),child=row.firstElementChild;
        return {key:row.getAttribute('data-row-key'),top:box.top,height:box.height,opacity:child?getComputedStyle(child).opacity:null,transform:child?getComputedStyle(child).transform:null};
      }),
      text:document.body?.innerText.slice(-700),...extra})}).catch(()=>{});
  }
  function fault(error) {
    if(window.__fixtureErrors.length<40) window.__fixtureErrors.push(error);
    diag({event:'error'});
  }
  addEventListener('error',e=>fault({message:e.message,stack:e.error?.stack}));
  addEventListener('unhandledrejection',e=>fault({message:String(e.reason),stack:e.reason?.stack}));
  const originalError=console.error;
  console.error=(...args)=>{fault({console:args.map(a=>String(a)).join(' ')});originalError(...args)};
  addEventListener('pageshow',()=>diag({event:'pageshow'}));
  addEventListener('pagehide',()=>diag({event:'pagehide'}));
  setInterval(diag,1000);
  const started=performance.now();
  Date.now=()=>${manifest.fixedNow ?? 1789905600000}+Math.floor(performance.now()-started);
</script>`
const server = Bun.serve({
  hostname: '127.0.0.1', port: 19687,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (request.headers.get('upgrade') === 'websocket') {
      if (server.upgrade(request,{data:{subscribed:false}})) return
    }
    if (url.pathname === '/__diag' && request.method === 'POST') {
      appendFileSync(`${root}/evidence/telemetry.ndjson`, JSON.stringify({time:Date.now(),...await request.json()})+'\n')
      return new Response(null, {status:204})
    }
    if (url.pathname === '/__fixture') return Response.json(manifest)
    if (url.pathname === '/sync/bootstrap') {
      const file = Bun.file(`${root}/scale.txt`)
      const scale = await file.exists() ? (await file.text()).trim() : '1'
      if (!['1','4'].includes(scale)) throw Error('Invalid corpus scale')
      if(!workingBootstrap.has(scale)) {
        const records=(await Bun.file(`${root}/bootstrap${scale === '4' ? '-4x' : ''}.ndjson`).text()).trim().split('\n').map(JSON.parse)
        for(const record of records) for(const row of record.changes??[]) {
          if(row.entity==='session' && row.entityId===sessionId) row.value={...row.value,
            status:'live',transcriptAvailable:true,agentState:{phase:'working',
              since:new Date(fixedNow-15_000).toISOString(),nativeSubagentCount:0}}
        }
        workingBootstrap.set(scale,records.map(record=>JSON.stringify(record)).join('\n')+'\n')
      }
      return new Response(workingBootstrap.get(scale),
        {headers:{'content-type':'application/x-ndjson'}})
    }
    if (url.pathname === '/sw.js') return new Response('', {status:404})
    if (url.pathname === '/mobile' || url.pathname.startsWith('/mobile/')) {
      const path = url.pathname.slice('/mobile'.length)
      const file = Bun.file(`${mobileRoot}${path}`)
      if (path && !path.includes('..') && await file.exists()) {
        return new Response(file,{headers:{'cache-control':'no-store'}})
      }
      const html = (await Bun.file(`${mobileRoot}/index.html`).text()).replace('<head>', '<head>'+telemetry)
      return new Response(html,{headers:{'content-type':'text/html','cache-control':'no-store'}})
    }
    if (url.pathname.startsWith('/trpc/')) {
      const names = url.pathname.slice(6).split(',')
      const batch = url.searchParams.get('batch') === '1'
      const input = url.searchParams.has('input') ? JSON.parse(url.searchParams.get('input'))
        : request.method === 'POST' ? await request.json() : {}
      const results = names.map((name,index) => {
        if (name === 'sessions.transcriptRead') return readTranscript(batch ? input[index] : input)
        if (request.method === 'POST') return {result:{data:null}}
        return procedures.get(name) ?? {error:{message:`Missing synthetic RPC: ${name}`,code:-32601,
          data:{code:'NOT_FOUND',httpStatus:404}}}
      })
      appendFileSync(`${root}/evidence/api.ndjson`,JSON.stringify({time:Date.now(),names,
        missing:names.filter(name=>name !== 'sessions.transcriptRead' && request.method !== 'POST' && !procedures.has(name))})+'\n')
      return Response.json(batch ? results : results[0])
    }
    if (api[url.pathname + url.search]) {
      const entry = api[url.pathname + url.search]
      return new Response(entry.body, {status:entry.status,headers:{'content-type':entry.type}})
    }
    if (/^\/(auth|setup|sync|version|health|files|client)\b/.test(url.pathname)) {
      return new Response('Unrecorded synthetic endpoint', {status:404})
    }
    const arm = (await Bun.file(`${root}/arm.txt`).text()).trim()
    if (!/^[a-z0-9-]+$/.test(arm)) throw Error('Invalid build arm')
    const file = Bun.file(`${root}/dist-${arm}${url.pathname}`)
    if (url.pathname !== '/' && !url.pathname.includes('..') && await file.exists()) {
      return new Response(file, {headers:{'cache-control':'no-store'}})
    }
    const ablationFile = Bun.file(`${root}/ablation.txt`)
    const ablation = await ablationFile.exists() ? (await ablationFile.text()).trim() : ''
    const style = ablation === 'no-mark' ? '<style>.pod-mark-frames{display:none!important;animation:none!important}</style>' : ''
    const html = (await Bun.file(`${root}/dist-${arm}/index.html`).text()).replace('<head>', '<head>'+telemetry+style)
    return new Response(html,{headers:{'content-type':'text/html','cache-control':'no-store'}})
  },
  websocket: {
    message(client, message) {
      const frame = JSON.parse(String(message))
      if (frame.type === 'ping') client.send(JSON.stringify({type:'pong'}))
      if (frame.type === 'hello') for (const saved of frames) {
        if (saved.type !== 'hostMetricsChanged') client.send(JSON.stringify(saved))
      }
      if (streamMode && frame.type === 'transcriptSubscribe' && frame.sessionId === sessionId) {
        subscribers.add(client)
        client.data.subscribed = true
        appendFileSync(`${root}/evidence/stream.ndjson`,JSON.stringify({time:Date.now(),event:'subscribe',items:transcript.length,since:frame.since})+'\n')
      }
      if (frame.type === 'transcriptUnsubscribe') subscribers.delete(client)
    },
    close(client) {subscribers.delete(client)},
  },
})
await Bun.write(`${root}/preview.pid`,String(process.pid))
console.log(`iPhone synthetic preview: ${server.url} (${manifest.issues} issues)`)
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  if (streamTimer) clearInterval(streamTimer)
  if (progressTimer) clearInterval(progressTimer)
  server.stop(true);process.exit(0)
})
await new Promise(()=>{})
