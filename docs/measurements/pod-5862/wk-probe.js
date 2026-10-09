// Counters and normal navigation/history controls only. Never exports text/IDs.
window.__memoryWK={errors:0,selected:false,health:{},listenerAdds:0,listenerRemoves:0,workers:new WeakSet(),targetSeq:Number(new URLSearchParams(location.search).get('memoryIssue')??5862)};
for(const [method,key] of [['addEventListener','listenerAdds'],['removeEventListener','listenerRemoves']]){
  const original=EventTarget.prototype[method];
  EventTarget.prototype[method]=function(...args){window.__memoryWK[key]++;return original.apply(this,args)};
}
addEventListener('error',()=>window.__memoryWK.errors++);
addEventListener('unhandledrejection',()=>window.__memoryWK.errors++);
window.__memoryWK.find=function(){
  const el=document.getElementById('root'),key=el&&Object.keys(el).find(k=>k.startsWith('__reactContainer$'));
  const start=el?.[key],fibers=[start?.stateNode?.current??start],seen=new Set();
  let pool,runtime;
  while(fibers.length&&(!pool||!runtime)){
    const f=fibers.pop();if(!f||seen.has(f))continue;seen.add(f);
    if(f.child)fibers.push(f.child);if(f.sibling)fibers.push(f.sibling);
    const objects=[{v:f.memoizedProps,d:0},{v:f.memoizedState,d:0}],checked=new Set();
    while(objects.length){
      const {v,d}=objects.pop();if(!v||typeof v!=='object'||checked.has(v)||d>5)continue;checked.add(v);
      if(v.tables&&v.graph&&v.queries)pool=v;
      if(typeof v.ownConversations==='function')runtime=v;
      for(const [k,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(v))){
        if(k==='next'&&d===0)objects.push({v:descriptor.value,d});
        else if(['pool','host','view','row','model','issue','session','worklist','memoizedState','value','current','deck','owner','runtime','conversation','core','engine','0','1','2','3'].includes(k))objects.push({v:descriptor.value,d:d+1});
      }
    }
  }
  if(pool)window.__memoryWK.pool=new WeakRef(pool);
  if(runtime)window.__memoryWK.runtime=new WeakRef(runtime);
  return !!pool&&!!runtime;
};
window.__memoryWK.sample=function(minute){
  const p=window.__memoryWK;if(!p.pool?.deref()||!p.runtime?.deref())p.find();
  if(!p.probing){p.probing=true;fetch('/auth/status').then(r=>r.json()).then(v=>p.health={authed:v.authed,needsAuth:v.needsAuth,ready:v.readiness?.state}).catch(()=>p.health={fetchFailed:true}).finally(()=>p.probing=false)}
  navigator.storage?.estimate().then(v=>p.storage={usageBytes:v.usage,quotaBytes:v.quota});
  const pool=p.pool?.deref(),runtime=p.runtime?.deref();
  let action=null;
  if(!p.selected&&pool){
    const issue=[...pool.tables.issue].find(([,row])=>row.seq===p.targetSeq)?.[0];
    const coordinator=pool.tables.issue.get(issue)?.coordinatorSessionId;
    const seat=coordinator&&pool.tables.session.has(coordinator)?coordinator:[...pool.tables.session].find(([,row])=>row.issueId===issue&&!row.exitedAt&&!row.archived)?.[0];
    p.targetSeat=seat;
    const el=document.querySelector('[data-issue-row]'),key=el&&Object.keys(el).find(k=>k.startsWith('__reactFiber$'));
    p.selection={issue:!!issue,seat:!!seat,issueRows:document.querySelectorAll('[data-issue-row]').length};
    for(let f=el?.[key];f;f=f.return)if(issue&&seat&&typeof f.memoizedProps?.onSelectPanelForIssue==='function'){
      f.memoizedProps.onSelectPanelForIssue({id:issue},seat);p.selected=true;action='select-session';break;
    }
    if(!p.selected&&issue&&seat&&runtime?.access?.openSessionTab){
      runtime.access.batchGesture(()=>{
        runtime.access.setSelectedIssueId(issue);
        runtime.access.openSessionTab(seat,{permanent:true});
        runtime.access.setView('workspace');
      });
      p.selected=true;action='open-session-workspace';
    }
  }else if(minute>=2){
    const buttons=[...document.querySelectorAll('.transcript-pager:not(:disabled)')].filter(b=>b.getBoundingClientRect().height>0);
    const button=buttons.find(b=>b.closest('[data-session]')?.getAttribute('data-session')===p.targetSeat)??buttons.at(-1);
    button?.click();action=button?'load-older':'no-visible-pager';
  }
  const cache=runtime?.conversationCache,owners=[];
  for(const {conversation:c,refs}of cache?.entries.values()??[]){
    const g=c.graph,i=g.searchIndex,v=c.presentation;
    const worker=v?.client.worker;
    if(worker){
      if(!p.workers.has(worker)){p.workers.add(worker);worker.addEventListener('message',event=>{if(event.data.kind==='__memory_counters')p.workerCounters=event.data.counters})}
      worker.postMessage({id:-5862,kind:'__memory_counters'});
    }
    owners.push({refs,items:c.transcript.ids.length,blocks:g.blockIds.length,rows:g.rowIds.length,pendingFrames:c.frames.pending.length,
      followTail:v?.followTail,renderCount:v?.renderCount,retainHistory:v?.retainHistory,
      index:{texts:i.texts.size,postings:i.postings.size,memberships:[...i.postings.values()].reduce((n,s)=>n+s.size,0),gramsById:i.gramsById.size,textChars:[...i.texts.values()].reduce((n,s)=>n+s.length,0)},
      client:v?{models:v.client.modelSources.size,pending:v.client.pending.size,queued:v.client.queued.size,markdownEntries:v.client.markdownHtml.size}:null});
  }
  return {minute,at:new Date().toISOString(),action,selected:p.selected,errors:p.errors,elements:document.querySelectorAll('*').length,
    workScroll:!!document.querySelector('[data-testid=work-scroll]'),canvas:document.querySelectorAll('canvas').length,
    animations:document.getAnimations().length,owners,cacheEntries:cache?.entries.size,warmEntries:cache?.warm.size,visibility:document.visibilityState,
    worker:p.workerCounters,selection:p.selection,health:p.health,storage:p.storage,jsHeapBytes:performance.memory?.usedJSHeapSize??null,listenerAdds:p.listenerAdds,listenerRemoves:p.listenerRemoves,passwordInputs:document.querySelectorAll('input[type=password]').length};
};
