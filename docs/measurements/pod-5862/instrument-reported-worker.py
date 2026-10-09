#!/usr/bin/env python3
"""Mac-only hooks in the exact dev.283 worker; never change normal messages.

The added handler returns cardinalities or clears only n-gram indexes on request.
It exports no record identifiers, source text or Markdown.
"""
from pathlib import Path
import sys

web=Path(sys.argv[1])
asset=web/'assets/transcript-compute.worker-BGr1QxHx.js'
source=asset.read_text()
assert 'gv=new Map' in source and 'gv.get(t.ownerKey)?.graph.dispose()' in source
assert source.rstrip().endswith('})();')
assert '__memoryOriginalMessage' not in source
hook=r'''
const __memoryOriginalMessage=mv.onmessage;
function __memoryWorkerCounters(){
  return {models:gv.size,markdownEntries:hv.size,owners:[...gv.values()].map(({graph:g})=>{
    const i=g.searchIndex;
    return {blocks:g.blockIds.length,rows:g.rowIds.length,index:{texts:i.texts.size,postings:i.postings.size,memberships:[...i.postings.values()].reduce((n,s)=>n+s.size,0),gramsById:i.gramsById.size,textChars:[...i.texts.values()].reduce((n,s)=>n+s.length,0)}};
  })};
}
mv.onmessage=(event)=>{
  if(event.data.kind==='__memory_freeze_search'){
    for(const {graph} of gv.values()){
      Object.getPrototypeOf(graph.searchIndex).grams=()=>new Set();
      graph.searchIndex.clear();
    }
  }else if(event.data.kind!=='__memory_counters'){
    __memoryOriginalMessage(event);return;
  }
  mv.postMessage({id:-5862,kind:'__memory_counters',ok:true,counters:__memoryWorkerCounters()});
};
'''
asset.write_text(source.rstrip()[:-5]+hook+'})();\n')
print('Instrumented exact dev.283 worker with counter-only control handler')
