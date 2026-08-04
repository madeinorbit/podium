import fs from 'fs';
const p=JSON.parse(fs.readFileSync('cdp.cpuprofile','utf8'));
const byId=new Map(p.nodes.map(n=>[n.id,n]));
const parent=new Map();
for(const n of p.nodes) for(const c of n.children||[]) parent.set(c,n.id);
const lbl=id=>{const f=byId.get(id).callFrame; return (f.functionName||'(anon)')+'@'+(f.url||'').replace(/^https?:\/\/[^/]+/,'')+':'+(f.lineNumber+1)+':'+(f.columnNumber+1);};
const selfUs=new Map();
for(let i=0;i<p.samples.length;i++) selfUs.set(p.samples[i],(selfUs.get(p.samples[i])||0)+(p.timeDeltas[i]||0));
const hot=[...selfUs].filter(([id])=>byId.get(id)&&byId.get(id).callFrame.functionName==='yo').sort((a,b)=>b[1]-a[1]);
console.log('yo total self:', (hot.reduce((s,x)=>s+x[1],0)/1e6).toFixed(1),'s across',hot.length,'nodes\n');
for(const [id,us] of hot.slice(0,4)){
  console.log('=== '+(us/1e6).toFixed(1)+'s stack (leaf -> root) ===');
  let cur=id,d=0;
  while(cur!==undefined&&d<22){ console.log('  '+lbl(cur)); cur=parent.get(cur); d++; }
  console.log();
}
