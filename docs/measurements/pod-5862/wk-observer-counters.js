// Count only MobX atoms/observer edges belonging to cached transcript graphs.
// Direct administration reads do not evaluate model getters or retain records.
{
  const p=window.__memoryWK,original=p.sample;
  p.sample=function(minute){
    const value=original(minute);
    value.transcriptMobx=[...p.runtime.deref().conversationCache.entries.values()].map(({conversation:c})=>{
      const seen=new Set(),stats={atoms:0,observerEdges:0,dependencyEdges:0};
      function walk(v){
        if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);
        if(v.observers_ instanceof Set){stats.atoms++;stats.observerEdges+=v.observers_.size;stats.dependencyEdges+=v.observing_?.length??0;return}
        walk(v.keysAtom_);walk(v.atom_);
        if(v.data_ instanceof Map)for(const entry of v.data_.values()){walk(entry);if(entry.value_?.atom_)walk(entry.value_)}
        if(v.hasMap_ instanceof Map)for(const entry of v.hasMap_.values())walk(entry);
        if(v instanceof Map)for(const entry of v.values())if(entry?.observers_ instanceof Set)walk(entry);
      }
      const graph=c.graph;
      for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(graph)))walk(descriptor.value);
      walk(graph.searchIndex.texts);walk(graph.searchIndex.postings);
      return stats;
    });
    return value;
  };
}
