#!/usr/bin/env python3
"""Render the anonymous native curves as a standalone review artifact."""
import argparse
import json
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--baseline',type=Path,required=True)
p.add_argument('--fixed',type=Path,required=True)
p.add_argument('--out',type=Path,required=True)
p.add_argument('--landed',default='')
a=p.parse_args()
data={'Reported build; search index removed at minute 7':json.loads(a.baseline.read_text()),
      'Fixed build; no removal or freeze':json.loads(a.fixed.read_text())}
status='Landed on integrate/4286-pilot: '+a.landed if a.landed else 'Fix implemented; native capture and final landing are still in progress.'
html='''<!doctype html><meta charset="utf-8"><title>Transcript search memory evidence</title>
<style>
body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:0 24px;color:#202731;background:#f7f9fb}
h1{font-size:28px}p{line-height:1.5}select{padding:8px;font:inherit;max-width:100%;margin:4px 8px 4px 0}
.status{background:#eaf1fb;border-left:4px solid #1978b6;padding:12px 16px}
svg{background:white;border:1px solid #d9e0e6;width:100%;height:auto;margin-top:12px}
table{border-collapse:collapse;width:100%;background:white;font-size:13px}th,td{padding:8px;border-bottom:1px solid #d9e0e6;text-align:right}th:first-child,td:first-child{text-align:left}
small{display:block;color:#4e5b68;margin:12px 0}code{background:#e8edf2;padding:2px 4px}
</style>
<h1>Transcript search memory evidence</h1>
<p class="status">__STATUS__</p>
<p><b>Growing owner:</b> <code>TranscriptSearchIndex.postings</code> and <code>gramsById</code>.
Both the UI and compute worker eagerly created n-gram memberships for every loaded block while search was empty.
The fix keeps the incremental index only while search is observed, releases it when the last reader leaves,
and retains normalized text for snapshot searches. The worker owns and disposes its search reaction with its model.</p>
<p><b>Removal proof:</b> at minute 7, the reported build's main and worker search indexes were cleared
(including their normalized text copies) and further n-gram creation was suppressed.
Raw transcripts, live intake, paging and rendering continued.
From minute 8 to 15, loaded items rose from 2,849 to 5,674 and DOM elements from 44,716 to 94,403;
footprint was 2,964 then 2,984 MiB. Both posting counts remained zero.
Worker counters are one response behind the main-thread sample.</p>
<select id="run" aria-label="Capture"></select><select id="metric" aria-label="Metric"></select>
<svg id="chart" viewBox="0 0 1000 340" aria-label="Native memory and owner curve"></svg>
<small id="caption"></small><table id="table"></table>
<p><b>Matched workload:</b> real operator records, normal history paging once per minute,
followed by an idle phase in the fixed capture (minutes 21–25; live intake continues),
in an AppKit <code>WKWebView</code> on the leased Tart Mac (macOS/Safari 26.6.2).
The reported frontend is <code>0.1.1-dev.283+de058fe</code>.
The fixed frontend is <code>23fec0a035</code>: that same source plus the two product files,
verified identical to the pilot candidate. Both match the live backend's wire version 4 and schema digest
<code>2f07b2a7138c6655</code>. The newer pilot schema is validated separately on flatblock.</p>
<p>Only anonymous counter hooks are added to the copied workers. The fixed worker has no freeze handler.
The page process is identified by a unique 2.5-second CPU burst, then sampled with
<code>proc_pid_rusage</code>. Storage is nonpersistent; credentials travel through an unnamed pipe.
The capture's 7 GiB safety limit prevents intentionally exhausting the shared Mac.</p>
<p><b>Limits:</b> this reproduces growth below the reported 17 GB threshold; it does not reproduce that threshold.
This is a native WebKit host, not the installed Tauri shell. WebKit exposes no
<code>performance.memory</code> here. Footprint includes compressed memory and differs from resident memory.
DOM counts cover attached elements. Listener values count registration/removal calls, not unique live listeners;
observer edges cover selected transcript graph atoms, not the whole MobX heap.
Origin storage usage is an estimate, not an exact IndexedDB byte census.
The removal capture ended after minute 18 on an SSH timeout; the fixed collector is detached from SSH.</p>
<p><b>Validation:</b> 13 client-core and 2 worker regressions; full typecheck (29/29);
lean gate (4 files, 154 tests and required lints); zero interaction-scan ratchet errors;
normal web build; full <code>speed:structural</code> on the rebased pilot tip under
<code>meter:flatblock</code> (30 passed, zero unexpected counters, peak RSS 4.9 GiB).</p>
<script>
const data=__DATA__,run=document.getElementById('run'),metric=document.getElementById('metric');
const names={footprintMiB:'Native footprint (MiB)',residentMiB:'Resident memory (MiB)',items:'Loaded transcript items',
mainMemberships:'Main-thread n-gram memberships',workerMemberships:'Worker n-gram memberships',elements:'Attached DOM elements',
mainTextChars:'Main normalized text characters',workerTextChars:'Worker normalized text characters',
listenerAdds:'Listener registration calls',listenerRemoves:'Listener removal calls',observerEdges:'Selected transcript observer edges',
originStorageMiB:'Estimated origin storage (MiB)',animations:'Live animations',pendingFrames:'Pending transcript frames'};
for(const name of Object.keys(data))run.add(new Option(name,name));
for(const [key,label]of Object.entries(names))metric.add(new Option(label,key));
run.value=Object.keys(data)[1];
function draw(){
const rows=data[run.value],key=metric.value,all=Object.values(data).flat(),maxX=Math.max(...all.map(r=>r.minute),1),maxY=Math.max(...all.map(r=>r[key]??0),1)*1.1;
const x=n=>70+n/maxX*900,y=n=>290-n/maxY*250;
let svg='';for(let i=0;i<=4;i++){const n=maxY*i/4,at=y(n);svg+=`<line x1="70" x2="970" y1="${at}" y2="${at}" stroke="#e2e8ee"/><text x="62" y="${at+5}" text-anchor="end" font-size="12">${Math.round(n).toLocaleString()}</text>`}
if(run.value===Object.keys(data)[0])svg+=`<line x1="${x(7)}" x2="${x(7)}" y1="25" y2="290" stroke="#a25700" stroke-dasharray="5 4"/><text x="${x(7)+7}" y="24" font-size="12">Search index removed</text>`;
const idle=rows.find(r=>r.action==='idle');if(idle)svg+=`<line x1="${x(idle.minute)}" x2="${x(idle.minute)}" y1="25" y2="290" stroke="#617c62" stroke-dasharray="5 4"/><text x="${x(idle.minute)+7}" y="24" font-size="12">Idle</text>`;
svg+=`<polyline points="${rows.map(r=>`${x(r.minute)},${y(r[key])}`).join(' ')}" fill="none" stroke="#1978b6" stroke-width="3"/>`;
for(const r of rows)svg+=`<circle cx="${x(r.minute)}" cy="${y(r[key])}" r="3" fill="#1978b6"><title>Minute ${r.minute}: ${r[key].toLocaleString()}</title></circle>`;
svg+=`<text x="70" y="318" font-size="12">0 min</text><text x="970" y="318" text-anchor="end" font-size="12">${maxX} min</text>`;
document.getElementById('chart').innerHTML=svg;
document.getElementById('caption').textContent=`${names[key]} · ${rows.length} minute samples · same zero-based scale in both captures · hover for values.`;
document.getElementById('table').innerHTML='<tr><th>Minute</th><th>Footprint MiB</th><th>Items</th><th>DOM</th><th>Main memberships</th><th>Worker memberships</th><th>Errors</th></tr>'+rows.map(r=>`<tr><td>${r.minute}</td><td>${r.footprintMiB.toFixed(1)}</td><td>${r.items.toLocaleString()}</td><td>${r.elements.toLocaleString()}</td><td>${r.mainMemberships.toLocaleString()}</td><td>${r.workerMemberships.toLocaleString()}</td><td>${r.errors}</td></tr>`).join('');
}run.onchange=draw;metric.onchange=draw;draw();
</script>'''
a.out.write_text(html.replace('__STATUS__',status).replace('__DATA__',json.dumps(data,separators=(',',':')).replace('<','\\u003c')))
print(json.dumps({'artifact':str(a.out),'samples':{k:len(v) for k,v in data.items()}}))
