#!/usr/bin/env python3
"""Export numeric page evidence; omit private records and process arguments."""
import base64
import gzip
import json
from pathlib import Path
import sys
import time

root=Path(sys.argv[1])
attribution=json.loads((root/'page-attribution.json').read_text())
pid=max(attribution['cpuDeltas'],key=lambda p:p['nanoseconds'])['pid']
rows=[]
for line in (root/'curve.jsonl').read_text().splitlines():
    value=json.loads(line)
    if 'minute' not in value or not value.get('owners'):continue
    process=next((p for p in value.get('processes',[]) if p['pid']==pid),None)
    if not process:continue
    owners=value['owners']
    worker=value.get('worker',{}).get('owners',[])
    rows.append({
        'minute':value['minute'],'footprintMiB':process['footprintBytes']/2**20,
        'residentMiB':process.get('residentBytes',process.get('rssKiB',0)*1024)/2**20,
        'items':sum(p['items'] for p in owners),'elements':value['elements'],
        'mainMemberships':sum(p['index']['memberships'] for p in owners),
        'workerMemberships':sum(p['index']['memberships'] for p in worker),
        'mainTextChars':sum(p['index']['textChars'] for p in owners),
        'workerTextChars':sum(p['index']['textChars'] for p in worker),
        'pendingFrames':sum(p['pendingFrames'] for p in owners),
        'listenerAdds':value['listenerAdds'],'listenerRemoves':value['listenerRemoves'],
        'observerEdges':sum(p['observerEdges'] for p in value.get('transcriptMobx',[])),
        'originStorageMiB':value.get('storage',{}).get('usageBytes',0)/2**20,
        'animations':value['animations'],'errors':value['errors'],
        'heapMiB':None if value.get('jsHeapBytes') is None else value['jsHeapBytes']/2**20,
        'action':value['action'],'searchFrozen':value.get('searchFrozen',False),
        'workloadPhase':value.get('workloadPhase','history'),
        'workScroll':value['workScroll'],'health':value['health'],
    })
payload=json.dumps(rows,separators=(',',':'))
if '--chunked' in sys.argv[2:]:
    encoded=base64.b64encode(gzip.compress(payload.encode())).decode()
    for offset in range(0,len(encoded),240):
        print(encoded[offset:offset+240],flush=True)
        time.sleep(.05)
else:
    print(payload)
