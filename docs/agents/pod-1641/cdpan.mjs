import fs from 'fs';
const p = JSON.parse(fs.readFileSync('cdp.cpuprofile','utf8'));
const byId = new Map(p.nodes.map(n=>[n.id,n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children||[]) parent.set(c, n.id);
const label = n => { const f=n.callFrame; const loc=f.url? f.url.replace(/^https?:\/\/[^/]+/,'')+':'+(f.lineNumber+1)+':'+(f.columnNumber+1):''; return (f.functionName||'(anon)')+' '+loc; };
// self time
const self = new Map();
const total = p.samples.length;
const dt = p.timeDeltas;
const selfUs = new Map();
for (let i=0;i<p.samples.length;i++){ const id=p.samples[i]; const t=dt[i]||0;
  selfUs.set(id,(selfUs.get(id)||0)+t); }
const rows=[...selfUs].map(([id,us])=>({n:byId.get(id),us})).filter(r=>r.n).sort((a,b)=>b.us-a.us);
const spanUs = dt.reduce((s,x)=>s+x,0);
console.log('profile span', (spanUs/1e6).toFixed(1),'s; samples',total);
console.log('\n--- TOP SELF TIME ---');
for (const r of rows.slice(0,25)) console.log((r.us/1e6).toFixed(2).padStart(8)+'s', (100*r.us/spanUs).toFixed(1).padStart(5)+'%', label(r.n).slice(0,120));
// inclusive
const incl = new Map();
for (const r of rows){ let id=r.n.id; const seen=new Set();
  while(id!==undefined){ if(!seen.has(id)){seen.add(id); incl.set(id,(incl.get(id)||0)+r.us);} id=parent.get(id); } }
console.log('\n--- TOP INCLUSIVE ---');
for (const [id,us] of [...incl].sort((a,b)=>b[1]-a[1]).slice(0,30)) console.log((us/1e6).toFixed(2).padStart(8)+'s',(100*us/spanUs).toFixed(1).padStart(5)+'%', label(byId.get(id)).slice(0,120));
