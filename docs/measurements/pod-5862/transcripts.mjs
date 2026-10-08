/** Inspect cached transcript owners; export only cardinalities and lengths. */
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
const {endpoint}=JSON.parse(readFileSync(process.argv[2]+'/browser-endpoint.json','utf8'))
const browser=await chromium.connect(endpoint),cdp=await browser.newBrowserCDPSession()
const {targetInfos}=await cdp.send('Target.getTargets')
const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:targetInfos.find(t=>t.type==='page').targetId,flatten:false})
const mode=process.argv[3]??'counts'
const expression=`(() => {
  let runtime=globalThis.__memoryRuntime?.deref();
  const element=document.getElementById('root');
  const key=element&&Object.keys(element).find(k=>k.startsWith('__reactContainer$'));
  const start=element?.[key],fibers=[start?.stateNode?.current??start],seen=new Set();
  while(fibers.length&&!runtime) {
    const f=fibers.pop();if(!f||seen.has(f))continue;seen.add(f);
    if(f.child)fibers.push(f.child);if(f.sibling)fibers.push(f.sibling);
    const objects=[{v:f.memoizedProps,d:0},{v:f.memoizedState,d:0}],checked=new Set();
    while(objects.length&&!runtime) {
      const {v,d}=objects.pop();if(!v||typeof v!=='object'||checked.has(v)||d>5)continue;checked.add(v);
      if(typeof v.ownConversations==='function'){runtime=v;globalThis.__memoryRuntime=new WeakRef(v);break}
      for(const [k,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
        if(k==='next'&&d===0)objects.push({v:descriptor.value,d});
        else if(['pool','host','view','row','model','issue','session','worklist','memoizedState','value','current','deck','owner','runtime','conversation','0','1','2','3'].includes(k))objects.push({v:descriptor.value,d:d+1});
      }
    }
  }
  if(!runtime)return {found:false};
  const cache=runtime.conversationCache;
  if(${JSON.stringify(mode)}==='self') {
    const pool=globalThis.__memoryPool?.deref();
    const issue=[...(pool?.tables.issue??[])].find(([,r])=>r.seq===5862)?.[0];
    const seat=[...(pool?.tables.session??[])].find(([,r])=>r.issueId===issue&&!r.exitedAt&&!r.archived)?.[0];
    const el=document.querySelector('[data-issue-row]');
    const key=el&&Object.keys(el).find(k=>k.startsWith('__reactFiber$'));
    for(let f=el?.[key];f;f=f.return)if(issue&&seat&&typeof f.memoizedProps?.onSelectPanelForIssue==='function'){f.memoizedProps.onSelectPanelForIssue({id:issue},seat);return {selected:true}}
    return {selected:false,issue:!!issue,seat:!!seat};
  }
  const owners=[];
  for(const {conversation:c,refs} of cache?.entries.values()??[]) {
    const graph=c.graph??c.transcriptGraph,index=graph?.searchIndex;
    if(${JSON.stringify(mode)}==='freeze-search'&&index){
      const prototype=Object.getPrototypeOf(index);
      if(!globalThis.__memorySearchOriginal){globalThis.__memorySearchOriginal=prototype.grams;prototype.grams=()=>new Set()}
      index.clear();
    }
    owners.push({refs,keys:Object.keys(c),graphKeys:graph?Object.keys(graph):[],items:c.transcript?.ids?.length,
      index:index?{texts:index.texts.size,postings:index.postings.size,memberships:[...index.postings.values()].reduce((n,v)=>n+v.size,0),gramsById:index.gramsById.size,textChars:[...index.texts.values()].reduce((n,v)=>n+v.length,0)}:null});
  }
  return {found:true,entries:cache?.entries.size,warm:cache?.warm.size,owners};
})()`
const response=new Promise(resolve=>cdp.on('Target.receivedMessageFromTarget',e=>{const m=JSON.parse(e.message);if(e.sessionId===sessionId&&m.id===1)resolve(m)}))
await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}})})
console.log(JSON.stringify({at:new Date().toISOString(),response:await response}))
await cdp.send('Target.detachFromTarget',{sessionId});await browser.close()
