"""Render the standalone paired production report from the saved browser samples."""
import argparse
import base64
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--before', required=True)
parser.add_argument('--after', required=True)
parser.add_argument('--before-image', required=True)
parser.add_argument('--after-image', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
data = {arm: json.loads(Path(getattr(args, arm)).read_text()) for arm in ('before', 'after')}
images = {arm: 'data:image/png;base64,' + base64.b64encode(Path(getattr(args, arm + '_image')).read_bytes()).decode() for arm in ('before', 'after')}
html = r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcript window production evidence</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f7;color:#182433;font:16px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:40px 24px}h1{font-size:30px;letter-spacing:-.7px;margin:0 0 12px}h2{font-size:20px;margin:24px 0 8px}p{max-width:850px}section{background:white;border:1px solid #d8dde5;border-radius:10px;padding:24px;margin:20px 0}.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center}select,button{font:inherit;padding:7px 12px;border:1px solid #b9c3cf;border-radius:5px;background:white;cursor:pointer}button[aria-pressed=true]{background:#182433;color:white}input{flex:1;min-width:200px}table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:8px;border-bottom:1px solid #e2e6ec}th:first-child,td:first-child{text-align:left}svg{display:block;width:100%;height:auto;margin:12px 0}.legend{display:flex;gap:24px}.original{color:#9d4351}.windowed{color:#087f79}small{color:#546579}img{width:100%;display:block;border:1px solid #d8dde5;margin-top:16px}.numbers{font-variant-numeric:tabular-nums}code{font-size:13px;overflow-wrap:anywhere}
</style><main><h1>Transcript window production evidence</h1>
<p>Matched minified Chromium fixtures, 8,058 synthetic messages. The same transcript rows and scroll controller run in both arms; the original arm restores the pilot's feed, scroll and stylesheet sources.</p>
<section><div class="controls"><label>Measure <select id="metric"><option value="elements">Attached elements</option><option value="heapUsed">JS heap after GC (MiB)</option><option value="rendererResidentBytes">Renderer resident memory (MiB)</option></select></label></div>
<div class="legend"><span class="original">Original</span><span class="windowed">Windowed</span></div><svg id="chart" viewBox="0 0 960 330" role="img" aria-label="Memory or DOM count versus loaded messages"></svg>
<div class="controls"><label for="phase">Loaded messages</label><input id="phase" type="range" min="0" max="5" value="5"><strong id="loaded" class="numbers"></strong></div>
<table class="numbers"><thead><tr><th>At this phase</th><th>Original</th><th>Windowed</th><th>Change</th></tr></thead><tbody id="values"></tbody></table>
<p><small>Resident memory is Linux renderer VmRSS, including its native allocations. It is not WKWebView physical footprint. Raw corpus data is allocated up front in both arms; retained shells and text still grow with loaded history.</small></p></section>
<section><h2>Scroll, selection and Find</h2><table><tbody id="checks"></tbody></table>
<p>Native Ctrl/Cmd+F temporarily mounts every loaded rich row so the browser owns the original ranges and match count. Closing Find restores the buffer and retains the committed selection. Select All likewise needs all rows until its selection clears. Application transcript search uses a buffered block jump.</p>
<p><strong>Open limitation:</strong> first opening native Find from the browser menu bypasses the keyboard hook. The hidden-text fallback can lose a wrapped return jump in Chromium. Coordinator review is required; native Mac behavior has not been measured.</p></section>
<section><h2>Same transcript view</h2><div class="controls"><button id="before" aria-pressed="false">Original</button><button id="after" aria-pressed="true">Windowed</button></div><img id="shot" alt="Transcript at the same addressed message"></section>
<p><small id="source"></small></p></main><script>
const data=__DATA__,images=__IMAGES__,$=id=>document.getElementById(id),fmt=n=>n.toLocaleString('en-US',{maximumFractionDigits:2});
const metrics=[['elements','Attached elements',1],['drawn','Rich message rows',1],['heapUsed','JS heap (MiB)',1048576],['rendererResidentBytes','Renderer RSS (MiB)',1048576],['height','Transcript height (px)',1]];
function render(){const i=+$('phase').value,b=data.before.samples[i],a=data.after.samples[i];$('loaded').textContent=fmt(a.loaded);$('values').innerHTML=metrics.map(([key,label,unit])=>`<tr><td>${label}</td><td>${fmt(b[key]/unit)}</td><td>${fmt(a[key]/unit)}</td><td>${fmt((a[key]/b[key]-1)*100)}%</td></tr>`).join('');
const metric=$('metric').value,unit=metric==='elements'?1:1048576,maximum=Math.max(...Object.values(data).flatMap(r=>r.samples.map(s=>s[metric]/unit)))*1.1,x=n=>65+n/8058*855,y=n=>280-n/maximum*240;let svg='';
for(let t=0;t<=4;t++){const v=maximum*t/4;svg+=`<line x1="65" x2="920" y1="${y(v)}" y2="${y(v)}" stroke="#dfe5ec"/><text x="55" y="${y(v)+5}" text-anchor="end" font-size="12">${fmt(v)}</text>`}
for(const arm of ['before','after']){const color=arm==='before'?'#9d4351':'#087f79';svg+=`<polyline points="${data[arm].samples.map(s=>`${x(s.loaded)},${y(s[metric]/unit)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3"/>`;svg+=`<circle cx="${x(data[arm].samples[i].loaded)}" cy="${y(data[arm].samples[i][metric]/unit)}" r="5" fill="${color}"/>`}
for(const n of [0,2000,4000,6000,8058])svg+=`<text x="${x(n)}" y="305" text-anchor="middle" font-size="12">${fmt(n)}</text>`;$('chart').innerHTML=svg;}
const b=data.before,a=data.after,blank=r=>r.fastScroll.filter(s=>s.visible===0).length,anchor=r=>r.pagingAnchor?`${r.pagingAnchor.after.key}, ${fmt(r.pagingAnchor.after.offset-r.pagingAnchor.before.offset)}px drift`:'Not captured';
$('checks').innerHTML=[['Fast-scroll first paints',`${b.fastScroll.length} samples / ${blank(b)} blank`,`${a.fastScroll.length} samples / ${blank(a)} blank`],['Paging anchor',anchor(b),anchor(a)],['Addressed jump',`${b.jump.key}, ${b.jump.offset}px`,`${a.jump.key}, ${a.jump.offset}px`],['Native clipboard',b.selectionCopy.selected===b.selectionCopy.copied?'Exact':'Failed',a.selectionCopy.selected===a.selectionCopy.copied?'Exact':'Failed'],['Native Find round trip',b.nativeFindRoundTrip.map(s=>s.query.slice(-4)).join(' → '),a.nativeFindRoundTrip.map(s=>s.query.slice(-4)).join(' → ')],['Rich rows after Find closes',b.nativeReveal.drawn,a.nativeReveal.drawn],['Application errors',b.errors.length,a.errors.length]].map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('');
function show(arm){$('shot').src=images[arm];for(const name of ['before','after'])$(name).setAttribute('aria-pressed',String(name===arm))}
for(const arm of ['before','after'])$(arm).onclick=()=>show(arm);$('phase').oninput=render;$('metric').onchange=render;$('source').textContent=`Chromium ${a.browser}. Capture source ${a.revision}. Baseline ${a.baseline??'see README'}. Heavy gates and landing are owned by POD-5895.`;render();show('after');
</script></html>'''
Path(args.out).write_text(html.replace('__DATA__', json.dumps(data).replace('</', r'<\/')).replace('__IMAGES__', json.dumps(images)))
