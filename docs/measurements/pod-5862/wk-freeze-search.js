// Main AND worker postings only. Keep raw transcripts, rendering and live intake.
{
  const p=window.__memoryWK,workers=new Set();
  p.searchFrozen=true;
  for(const {conversation:c} of p.runtime.deref().conversationCache.entries.values()){
    const i=c.graph.searchIndex;
    Object.getPrototypeOf(i).grams=()=>new Set();
    i.clear();
    if(c.presentation?.client.worker)workers.add(c.presentation.client.worker);
  }
  for(const worker of workers)worker.postMessage({id:-5862,kind:'__memory_freeze_search'});
  const original=p.sample;
  p.sample=function(minute){const value=original(minute);value.searchFrozen=true;return value};
}
