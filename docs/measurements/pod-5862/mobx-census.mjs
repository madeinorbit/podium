/** Count live MobX objects in an already-owned Chromium target. No record data exported. */
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const out=process.argv[2]
const modulePath=process.argv[3]
const iterations=Number(process.argv[4]??1)
const {endpoint}=JSON.parse(readFileSync(join(out,'browser-endpoint.json'),'utf8'))
const browser=await chromium.connect(endpoint)
const client=await browser.newBrowserCDPSession()
const {targetInfos}=await client.send('Target.getTargets')
const target=targetInfos.find(t=>t.type==='page'&&t.url.startsWith('http://localhost:'))
if(!target)throw new Error('Owned target absent')
const {sessionId}=await client.send('Target.attachToTarget',{targetId:target.targetId,flatten:false})
let serial=0
const pending=new Map()
client.on('Target.receivedMessageFromTarget', e=>{if(e.sessionId!==sessionId)return;const m=JSON.parse(e.message),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}})
async function send(method,params={}){const id=++serial;const result=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));await client.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})});return result}
const rows=[]
try {
  const init=await send('Runtime.evaluate',{expression:`import(${JSON.stringify(modulePath)}).then(m=>{const a=m.h;globalThis.__memoryTypes={reaction:a.Reaction.prototype,computed:Object.getPrototypeOf(a.computed(()=>0)),atom:Object.getPrototypeOf(a.createAtom('memory.measurement'))}})`,awaitPromise:true})
  if(init.exceptionDetails)throw new Error('MobX export unavailable')
  for(let turn=0;turn<iterations;turn++){
    const counts={}
    for(const kind of ['reaction','computed','atom']) {
      const {result:prototype}=await send('Runtime.evaluate',{expression:`globalThis.__memoryTypes.${kind}`})
      const {objects}=await send('Runtime.queryObjects',{prototypeObjectId:prototype.objectId})
      try {
        const result=await send('Runtime.callFunctionOn',{objectId:objects.objectId,functionDeclaration:`function(){let disposed=0,dependencies=0,observerEdges=0,keepAlive=0;const names={};for(const v of this){disposed+=v.isDisposed?1:0;dependencies+=v.observing_?.length??0;observerEdges+=v.observers_?.size??0;keepAlive+=v.keepAlive_?1:0;const name=String(v.name_??v.constructor.name).split(/[.@:\\[]/,1)[0];names[name]=(names[name]??0)+1}return {count:this.length,disposed,dependencies,observerEdges,keepAlive,names}}`,returnByValue:true})
        if(result.exceptionDetails)throw new Error('Census evaluation failed')
        counts[kind]=result.result.value
      } finally { await send('Runtime.releaseObject',{objectId:objects.objectId});await send('Runtime.releaseObject',{objectId:prototype.objectId}) }
    }
    const value={turn,at:new Date().toISOString(),counts}
    rows.push(value);writeFileSync(join(out,'mobx-counts.json'),JSON.stringify(rows,null,2),{mode:0o600});console.log(JSON.stringify(value))
    if(turn<iterations-1)await new Promise(r=>setTimeout(r,60000))
  }
} finally { await client.send('Target.detachFromTarget',{sessionId}); await browser.close() }
