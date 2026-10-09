#!/usr/bin/env python3
"""Add anonymous counters to a copied fixed worker on the leased Mac only.

Regular worker messages and search lifetimes are unchanged. No freeze handler.
"""
from pathlib import Path
import re
import sys

web=Path(sys.argv[1])
assets=list((web/'assets').glob('transcript-compute.worker-*.js'))
assert len(assets)==1
asset=assets[0]
source=asset.read_text()
assert source.rstrip().endswith('})();') and '__memoryOriginalMessage' not in source
models=re.search(r'([\w$]+)\.get\([\w$]+\.ownerKey\)\?\.stopSearch\(\)',source).group(1)
scope=list(re.finditer(r'([\w$]+)\.onmessage=',source))[-1].group(1)
markdown=re.search(r'while\(([\w$]+)\.size>2048\)',source).group(1)
hook='''
const __memoryOriginalMessage=SCOPE.onmessage;
SCOPE.onmessage=event=>{
  if(event.data.kind!=='__memory_counters'){__memoryOriginalMessage(event);return;}
  const counters={models:MODELS.size,markdownEntries:MARKDOWN.size,
    owners:[...MODELS.values()].map(({graph:g})=>{
      const i=g.searchIndex;
      return {blocks:g.blockIds.length,rows:g.rowIds.length,index:{
        texts:i.texts.size,postings:i.postings.size,
        memberships:[...i.postings.values()].reduce((n,s)=>n+s.size,0),
        gramsById:i.gramsById.size,textChars:[...i.texts.values()].reduce((n,s)=>n+s.length,0)
      }};
    })};
  SCOPE.postMessage({id:-5862,kind:'__memory_counters',ok:true,counters});
};
'''.replace('SCOPE',scope).replace('MODELS',models).replace('MARKDOWN',markdown)
asset.write_text(source.rstrip()[:-5]+hook+'})();\n')
print('Added counter-only hook to copied fixed worker')
