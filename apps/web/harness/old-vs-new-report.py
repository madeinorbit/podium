"""Render raw run observations; missing cells never become zero or a win."""
import argparse
import collections
import html
import json
import math
import pathlib
import statistics

parser=argparse.ArgumentParser()
parser.add_argument('--raw',default='docs/measurements/POD-4286-old-vs-new/raw')
args=parser.parse_args()
root=pathlib.Path(args.raw)
runs=[json.loads(file.read_text()) for file in sorted(root.rglob('run.json'))]
valid=[run for run in runs if run['status']=='complete']
q=lambda values,p: sorted(values)[max(0,math.ceil(len(values)*p)-1)]
fmt=lambda value: '—' if value is None else f'{value:,.1f}'
cells=collections.defaultdict(list)
for run in valid:
    if run['mode']!='timing':continue
    for row in run['actions']:
        if row.get('profiled') or 'inputToPaintMs' not in row:continue
        cells[(run['surface'],run['scale'],row['action'],run['arm'])].append(row)
metrics=[]
new_arms=sorted({run['arm'] for run in valid if run['arm']!='old'}) or ['new']
for new in new_arms:
    keys=sorted({(surface,scale,action) for surface,scale,action,arm in cells if arm in ['old',new]})
    for surface,scale,action in keys:
        old=cells[(surface,scale,action,'old')];candidate=cells[(surface,scale,action,new)]
        stat=lambda rows:None if not rows else {'n':len(rows),'median':statistics.median(row['inputToPaintMs'] for row in rows),'p95':q([row['inputToPaintMs'] for row in rows],.95),'max':max(row['inputToPaintMs'] for row in rows),'busyMedian':statistics.median(row['mainThreadBusyMs'] for row in rows) if all('mainThreadBusyMs' in row for row in rows) else None,'layoutMedian':statistics.median(row['layoutMs'] for row in rows) if all('layoutMs' in row for row in rows) else None}
        a,b=stat(old),stat(candidate)
        change=(b['median']/a['median']-1)*100 if a and b and a['median'] else None
        tail=(b['p95']/a['p95']-1)*100 if a and b and a['p95'] else None
        verdict='not comparable' if change is None else ('faster' if change < -10 else 'slower' if change > 10 else 'no clear improvement')
        if verdict=='faster' and tail is not None and tail>10:verdict='faster median, worse tail'
        metrics.append({'newArm':new,'surface':surface,'scale':scale,'action':action,'old':a,'new':b,'changePercent':change,'p95ChangePercent':tail,'verdict':verdict})
summary={'runs':len(runs),'completeRuns':len(valid),'failedRuns':len(runs)-len(valid),'comparisons':metrics}
pathlib.Path('docs/measurements/POD-4286-old-vs-new/results.json').write_text(json.dumps(summary,indent=2)+'\n')
lines=['# OLD versus NEW whole-app measurements','','SUMMARY_PENDING','','## Compared applications','']
for arm in sorted({run['arm'] for run in runs}):
    shas=sorted({run['sha'] for run in runs if run['arm']==arm})
    lines.append(f'- **{arm.upper()}**: '+', '.join(f'`{sha}`' for sha in shas))
lines.extend(['','OLD corpus seed 4443: 4,867 issues and 4,304 sessions at 1x; 19,468 issues and 17,216 sessions at 4x. Two real isolated control issues and their live agents exercise mutations. Both arms consume the same serialized semantic corpus; the per-run digest proves the match. OLD receives its legacy issue and issue-projection rows; NEW receives normalized issue/session personal state and git/machine facts. Optional null strings are omitted to satisfy the production wire schema.','',f'Raw evidence: {len(valid)} completed runs, {len(runs)-len(valid)} failed runs. Failed captures and per-action gaps are retained and excluded from numerical comparisons.','', '## Latency, milliseconds','','Lower is better. Percent change is `(NEW / OLD − 1) × 100`. Percentiles use nearest rank; median averages the middle pair. Profiled samples are excluded. Differences within ±10% are labelled no clear improvement; this is a reporting band, not a statistical confidence interval. p95 from small samples is a limited tail estimate.','','| Surface | Scale | Action | NEW arm | OLD n | NEW n | OLD median | NEW median | OLD p95 | NEW p95 | Median change | p95 change | OLD max | NEW max | Verdict |','|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|'])
for item in metrics:
    a,b=item['old'] or {},item['new'] or {}
    lines.append('| '+' | '.join(map(str,[item['surface'],item['scale'],item['action'],item['newArm'],a.get('n',0),b.get('n',0),fmt(a.get('median')),fmt(b.get('median')),fmt(a.get('p95')),fmt(b.get('p95')),fmt(item['changePercent'])+'%',fmt(item['p95ChangePercent'])+'%',fmt(a.get('max')),fmt(b.get('max')),item['verdict']]))+' |')
lines.extend(['','## Main-thread work per action','','Timeline busy time is the union of main renderer tasks clipped to trusted input through qualifying Paint. Layout includes Layout and UpdateLayoutTree, clipped to the same interval. These overlap task time. CDP cumulative task/script/layout deltas include capture polling and are retained in raw data; do not mistake them for exclusive store or React time. Source-map sampled attribution is separately captured and labelled approximate. Store/derive is inclusive and overlaps React; never add these categories.','','| Surface | Scale | Action | NEW arm | OLD busy median | NEW busy median | OLD layout median | NEW layout median |','|---|---:|---|---|---:|---:|---:|---:|'])
for item in metrics:
    a,b=item['old'] or {},item['new'] or {}
    lines.append('| '+' | '.join(map(str,[item['surface'],item['scale'],item['action'],item['newArm'],fmt(a.get('busyMedian')),fmt(b.get('busyMedian')),fmt(a.get('layoutMedian')),fmt(b.get('layoutMedian'))]))+' |')
lines.extend(['','## Incoming updates and connected idle','','BACKGROUND_METHOD_PENDING','','| Arm | Surface | Scale | Update | n | Task ms/update median | p95 |','|---|---|---:|---|---:|---:|---:|'])
bg=collections.defaultdict(list)
for run in valid:
    for sample in run.get('background',[]):bg[(run['arm'],run['surface'],run['scale'],sample['kind'])].append(sample['taskMs'])
for key,values in sorted(bg.items()):lines.append('| '+' | '.join(map(str,[*key,len(values),fmt(statistics.median(values)),fmt(q(values,.95))]))+' |')
lines.extend(['','| Arm | Surface | Scale | Seconds | Updates delivered | Main-thread task ms | Main-thread busy % |','|---|---|---:|---:|---|---:|---:|'])
for run in valid:
    idle=run.get('idle')
    if idle:lines.append('| '+' | '.join(map(str,[run['arm'],run['surface'],run['scale'],fmt(idle['seconds']),json.dumps(idle['delivered']),fmt(idle['taskMs']),fmt(idle['taskMs']/idle['seconds']/10)]))+' |')
lines.extend(['','## Retained JavaScript heap','','Post-GC Runtime.getHeapUsage usedSize. One startup/5-minute pair per arm/surface/scale is an observation, not leak evidence. Memory runs use meter:flatblock and do not contribute timings.','','| Arm | Surface | Scale | Startup MiB | Five minutes MiB | Duration s | Actions |','|---|---|---:|---:|---:|---:|---:|'])
for run in valid:
    if 'heapFiveMinutes' in run:lines.append('| '+' | '.join(map(str,[run['arm'],run['surface'],run['scale'],fmt(run['heapStartup']['usedSize']/1048576),fmt(run['heapFiveMinutes']['usedSize']/1048576),fmt(run['heapUse']['durationSeconds']),run['heapUse']['actions']]))+' |')
lines.extend(['','## Action gaps and defects',''])
for run in runs:
    for gap in run.get('unavailable',[]):lines.append(f'- {run["arm"].upper()} {run["surface"]} {run["scale"]}x: **{gap["action"]}** — {gap["reason"].splitlines()[0]}')
    if run['status']=='failed':lines.append(f'- Failed capture {run["mode"]}/{run["arm"]}/{run["surface"]}/{run["scale"]}x/r{run["round"]}: {run.get("failure", "unknown").splitlines()[0]}')
lines.extend(['','## Run order, provenance, host load','','Runs execute sequentially on flatblock, one implementation per process. Leases are taken on ludovico after server/browser preparation, released as soon as capture ends. A fresh profile means cold start; reload of that profile means warm start. Pixel 7 Chromium emulation is phone web evidence, not physical Android/native performance. No CPU or network throttle is applied. No product source is changed. No full test suite runs.','','| Started UTC | Mode | Arm | Surface | Scale | Round | Status | Load start (1/5/15m) | Load end | Browser |','|---|---|---|---|---:|---:|---|---|---|---|'])
for run in sorted(runs,key=lambda r:r['startedAt']):lines.append('| '+' | '.join(map(str,[run['startedAt'],run['mode'],run['arm'],run['surface'],run['scale'],run['round'],run['status'],', '.join(fmt(n) for n in run['loadStart']),', '.join(fmt(n) for n in run.get('loadEnd',[])),run.get('browser','—')]))+' |')
lines.extend(['','## Evidence and reproduction','','Run and per-sample timestamps, SHAs, semantic/product digests, exact bootstrap counts, captured process IDs, lease grant, load, CPU deltas and failures are in the [raw run files](POD-4286-old-vs-new/raw/) and [machine-readable comparisons](POD-4286-old-vs-new/results.json). Compressed Chromium traces and sampled profiles are attached as raw evidence.','','REPRODUCTION_PENDING',''])
pathlib.Path('docs/measurements/POD-4286-old-vs-new.md').write_text('\n'.join(lines))
rows=[]
for item in metrics:
    a,b=item['old'] or {},item['new'] or {}
    fields=[item['surface'],f'{item["scale"]}x',item['action'],item['newArm'],f'{a.get("n",0)} / {b.get("n",0)}',fmt(a.get('median')),fmt(b.get('median')),fmt(a.get('p95')),fmt(b.get('p95')),fmt(item['changePercent'])+'%',fmt(item['p95ChangePercent'])+'%',item['verdict']]
    rows.append(f'<tr data-surface="{item["surface"]}" data-scale="{item["scale"]}" data-verdict="{item["verdict"]}">'+''.join('<td>'+html.escape(str(value))+'</td>' for value in fields)+'</tr>')
headers=['Surface','Scale','Action','NEW arm','n OLD / NEW','OLD median','NEW median','OLD p95','NEW p95','Median change','p95 change','Verdict']
page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OLD versus NEW app comparison</title><style>body{font:15px/1.5 system-ui;margin:24px;color:#16202c;background:#f7f8fa}h1{font-size:25px}table{border-collapse:collapse;background:white;width:100%}th,td{padding:9px 12px;border-bottom:1px solid #dee4e9;text-align:right;white-space:nowrap}td:first-child,td:nth-child(3),td:last-child{text-align:left}th{position:sticky;top:0;background:#e9eef3;cursor:pointer}tr[data-verdict="slower"] td:last-child{color:#b42318}tr[data-verdict="faster"] td:last-child{color:#067647}button,select,input{font:inherit;padding:7px;margin-right:10px}#table{overflow:auto;max-height:75vh}p{max-width:1000px}</style><h1>Was the MobX rewrite worth it?</h1><p id="summary">SUMMARY_PENDING</p><p>Unprofiled production Chromium input to qualifying Paint, in milliseconds. Lower is better. A negative change is an improvement. Pixel 7 means phone web emulation. Missing evidence is never scored as a win.</p><label>Surface <select id="surface"><option value="">All</option><option>web</option><option>phone</option></select></label><label>Scale <select id="scale"><option value="">Both</option><option value="1">1x</option><option value="4">4x</option></select></label><input id="search" placeholder="Find an action"><div id="table"><table><thead><tr>'''+''.join('<th>'+x+'</th>' for x in headers)+'''</tr></thead><tbody>'''+''.join(rows)+'''</tbody></table></div><p>±10% is a descriptive band, not a confidence interval. See the Markdown report for CPU, heap, SHAs, load, failures and coverage limits. Raw observations are retained.</p><script>const body=document.querySelector('tbody');function filter(){for(const row of body.rows)row.hidden=(surface.value&&row.dataset.surface!==surface.value)||(scale.value&&row.dataset.scale!==scale.value)||!row.textContent.toLowerCase().includes(search.value.toLowerCase())}for(const id of ['surface','scale','search'])document.getElementById(id).addEventListener('input',filter);document.querySelectorAll('th').forEach((head,index)=>head.addEventListener('click',()=>{const ascending=head.dataset.order!=='up';head.dataset.order=ascending?'up':'down';const rows=[...body.rows].sort((a,b)=>{const x=a.cells[index].textContent,y=b.cells[index].textContent;const nx=parseFloat(x.replaceAll(',','')),ny=parseFloat(y.replaceAll(',',''));return(ascending?1:-1)*(Number.isFinite(nx)&&Number.isFinite(ny)?nx-ny:x.localeCompare(y))});body.append(...rows)}));</script></html>'''
pathlib.Path('docs/measurements/POD-4286-old-vs-new.html').write_text(page)
print(json.dumps({'runs':len(runs),'complete':len(valid),'comparisonCells':len(metrics)}))
