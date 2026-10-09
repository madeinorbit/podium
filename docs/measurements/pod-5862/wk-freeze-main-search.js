// Diagnostic removal: only main-thread n-gram postings. Keep history/feed/DOM.
{
  const p=window.__memoryWK,cache=p.runtime.deref().conversationCache;
  p.searchFrozenMain=true;
  for(const {conversation:c} of cache.entries.values()){
    const i=c.graph.searchIndex,proto=Object.getPrototypeOf(i);
    p.originalGrams??=proto.grams;
    proto.grams=()=>new Set();
    i.clear();
  }
  // Keep paging after the original 14-minute probe window: intake must continue
  // for a freeze to be a counterfactual rather than coinciding with an idle view.
  const sample=p.sample;
  p.sample=function(minute){
    const value=sample(minute);
    if(minute>14){
      const button=[...document.querySelectorAll('.transcript-pager:not(:disabled)')].find(b=>b.getBoundingClientRect().height>0);
      button?.click();value.action=button?'load-older':'no-visible-pager';
    }
    value.searchFrozenMain=true;
    return value;
  };
}
