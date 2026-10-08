"""Publish numeric evidence only; never publish private logs, heaps or text."""
import argparse
import json
from pathlib import Path

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--private-root',type=Path,required=True)
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args()

def live(name,limit=None):
    rows=json.loads((args.private_root/name/'samples.json').read_text())
    values=[]
    for row in rows:
        if row.get('workScroll') is False or (limit is not None and row['minute']>limit):continue
        renderer=next((p for p in reversed(row['processes']) if p['kind']=='renderer'),{})
        values.append({
            'minute':row['minute'],'heapMiB':row['heap']['usedSize']/2**20 if row['heap'] else None,
            'rendererRssMiB':renderer.get('rssKiB',0)/1024,'domNodes':row['dom']['nodes'] if row['dom'] else row['elements'],
            'elements':row['elements'],'listeners':row['dom']['jsEventListeners'] if row['dom'] else None,
            'idbMiB':row['storageBytes']/2**20,'animations':sum(a['total'] for a in row['animations'].values()),
            'keyframes':sum(a['keyframes'] for a in row['animations'].values()),
            'messages':row['messages'],'conversations':row.get('conversationCache'),
        })
    return values

native_index=[374934656,398118144,323308800,338840896,343641408,343510336,55512384,55512384]
data={
    'Warm idle Chromium, before invalid broad freeze':live('reported-283-curve',6),
    'Chromium chat → native at 9m; data-only freeze at 12m':live('reported-283-native'),
    'Chromium active streaming conversation':live('reported-283-stream'),
    'Safari synthetic search index, cleared before 4m sample':[
        {'minute':minute,'footprintMiB':value/2**20,'indexEntries':400 if minute<4 else 0}
        for minute,value in enumerate(native_index)],
}
# The native values were read from the driver output. No raw process table,
# record identifier, transcript, credential or error message is included.
payload=json.dumps(data,separators=(',',':')).replace('<','\\u003c')
html='''<!doctype html><meta charset="utf-8"><title>POD-5862 memory evidence</title>
<style>
body{font:16px system-ui;max-width:1000px;margin:36px auto;padding:0 24px;color:#202731;background:#f8fafb}
h1{font-size:28px}p{line-height:1.5;max-width:900px}select{padding:8px;font:inherit;max-width:100%}
.status{border-left:4px solid #a25700;background:#fff1d6;padding:12px 18px}
svg{background:white;border:1px solid #d9e0e6;width:100%;height:auto;margin:18px 0}
table{border-collapse:collapse;width:100%;background:white;font-size:14px}th,td{padding:9px;border-bottom:1px solid #d9e0e6;text-align:right}th:first-child,td:first-child{text-align:left}
code{background:#e8edf2;padding:2px 5px}small{display:block;color:#4e5b68;margin:10px 0}
</style>
<h1>POD-5862: memory evidence</h1>
<p class="status"><b>The reported 17 GB growth is not reproduced. No causal fix has been made or landed.</b><br>
These are diagnostic baselines. Native Safari with the operator's live records remains pending explicit authorization.</p>
<p>The frontend is the archived <code>0.1.1-dev.283+de058fe</code> production build.
Live-data captures ran only on ludovico against its live backend, whose wire schema matched the reported frontend.
Chromium heap samples follow two forced collections. Native Safari uses macOS physical footprint, including compressed memory.
Heap, resident memory and native footprint are different measurements.</p>
<select id="run"></select> <select id="metric"></select>
<svg id="chart" viewBox="0 0 950 350" aria-label="Memory capture curve"></svg>
<small id="caption"></small><table id="table"></table>
<p><b>What this establishes:</b> the warmed idle Chromium view stayed near 394 MiB; the native view stayed near 396–398 MiB
through the data-only feed freeze. The active streaming session has two conversations with roughly 200 items each.
Its search postings and frame queues have stayed bounded in the observed interval.</p>
<p>The search index is an expensive owner: its creation stacks dominated one navigation allocation sample,
and clearing a bounded synthetic index in Safari reduced page footprint from 308–380 MiB to 53 MiB after collection.
That is a cost measurement, <b>not proof that the index caused the reported leak</b>.
The synthetic fixture uses the reported production MobX asset and generated text; it contains no operator records.</p>
<p><b>Excluded evidence:</b> the first full heap snapshot never completed; early broad WebSocket freezes caused resyncs;
repeated navigation captures eventually unmounted the workspace; Linux WPE virtual address space is not a macOS footprint measurement.
None of those intervals is treated as a successful flat curve or a removal proof.</p>
<p>Remaining work: reproduce the reported condition in Safari on the operator's live records, identify the growing owner,
freeze that owner without unmounting the app, fix it, and verify the same workload. Product validation and pilot landing have not run.</p>
<script>
const data=__DATA__,run=document.getElementById('run'),metric=document.getElementById('metric'),chart=document.getElementById('chart');
const names={heapMiB:'Retained JS heap (MiB)',rendererRssMiB:'Renderer resident memory (MiB)',footprintMiB:'Native page footprint (MiB)',domNodes:'DOM nodes',listeners:'JS listeners',idbMiB:'IndexedDB usage (MiB)',elements:'Attached elements',indexEntries:'Indexed entries',messages:'Socket messages'};
for(const name of Object.keys(data))run.add(new Option(name,name));
run.value='Chromium active streaming conversation';
function changed(){const row=data[run.value][0],old=metric.value;metric.replaceChildren();for(const key of Object.keys(names))if(row?.[key]!=null)metric.add(new Option(names[key],key));if([...metric.options].some(o=>o.value===old))metric.value=old;draw()}
function draw(){
const rows=data[run.value],key=metric.value,values=rows.map(r=>r[key]),maxX=Math.max(...rows.map(r=>r.minute),1),maxY=Math.max(...values)*1.12||1;
const x=n=>64+n/maxX*850,y=n=>300-n/maxY*260;
let svg='';for(let i=0;i<=4;i++){const value=maxY*i/4,at=y(value);svg+=`<line x1="64" x2="914" y1="${at}" y2="${at}" stroke="#e2e8ee"/><text x="55" y="${at+5}" text-anchor="end" font-size="13">${value.toFixed(0)}</text>`}
svg+=`<polyline points="${rows.map(r=>`${x(r.minute)},${y(r[key])}`).join(' ')}" fill="none" stroke="#1978b6" stroke-width="3"/>`;
for(const row of rows)svg+=`<circle cx="${x(row.minute)}" cy="${y(row[key])}" r="4" fill="#1978b6"><title>Minute ${row.minute}: ${row[key].toFixed(2)}</title></circle>`;
svg+=`<text x="64" y="326" font-size="13">0 min</text><text x="914" y="326" text-anchor="end" font-size="13">${maxX} min</text>`;chart.innerHTML=svg;
const first=values[0],last=values.at(-1);document.getElementById('caption').textContent=`${names[key]} · ${rows.length} samples · first ${first.toFixed(2)}, last ${last.toFixed(2)} · full zero-based axis; hover a point for its value.`;
document.getElementById('table').innerHTML=`<tr><th>Minute</th><th>${names[key]}</th><th>Conversation items</th><th>Search memberships</th></tr>`+rows.map(row=>`<tr><td>${row.minute}</td><td>${row[key].toFixed(2)}</td><td>${row.conversations?.owners.map(c=>c.items).join(' / ')??'—'}</td><td>${row.conversations?.owners.map(c=>c.index?.memberships).join(' / ')??'—'}</td></tr>`).join('');
}run.onchange=changed;metric.onchange=draw;changed();
</script>'''
args.out.parent.mkdir(parents=True,exist_ok=True)
args.out.write_text(html.replace('__DATA__',payload))
print(json.dumps({'artifact':str(args.out),'samples':{name:len(rows) for name,rows in data.items()}}))
