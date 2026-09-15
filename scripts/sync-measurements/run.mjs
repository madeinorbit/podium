/** Run benchmark arms in A/B/B/A order. This is not an agent test gate.
 * Hold `podium lock acquire sync-gate --ttl 20m` while running; renew as needed.
 * bun --conditions=@podium/source scripts/sync-measurements/run.mjs <before-root> <after-root> <output-dir> [before|both] [smoke]
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const [beforeArg, afterArg, outArg, arms = 'both', scale = 'full'] = process.argv.slice(2)
if (!beforeArg || !afterArg || !outArg) throw new Error('before-root, after-root and output-dir required')
const beforeRoot = resolve(beforeArg), afterRoot = resolve(afterArg), out = resolve(outArg)
mkdirSync(out, { recursive: true })
const scriptRoot = import.meta.dirname
const beforeSha = '5133399843e81b7c6a7b4ebac51ed9d45bf0a045'
const afterSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PODIUM_')))
function execute(command, args, options = {}) {
  return new Promise((yes,no) => {
    const child = spawn(command,args,{stdio:'inherit',...options})
    child.on('error',no); child.on('exit',(code,signal)=>code===0?yes():no(new Error(`${command} exited ${code ?? signal}`)))
  })
}
const order = arms === 'before' ? ['before'] : ['before','after','after','before']
const summary=[]
for (let run=0;run<order.length;run++) {
  const arm=order[run], root=arm==='before'?beforeRoot:afterRoot, sha=arm==='before'?beforeSha:afterSha
  for (const [mode,coding] of [['bootstrap','identity'],['bootstrap','gzip'],['bootstrap','zstd'],['concurrent','identity'],['delta','identity']]) {
    if (arm==='before' && coding==='gzip') continue // Legacy WS bootstrap has no gzip representation.
    const name=`${run}-${arm}-${mode}-${coding}`, dir=join(out,name)
    if (existsSync(dir)) throw new Error(`Refusing to overwrite run ${dir}`)
    mkdirSync(dir)
    const ready=join(dir,'ready.json'), db=join(dir,'podium.db')
    const server=spawn('bun',['--conditions=@podium/source',join(scriptRoot,'server.mjs'),root,db,arm,ready,scale],
      {stdio:['ignore','pipe','pipe'],env:{...env,PODIUM_STATE_DIR:join(dir,'state')}})
    let logs=''
    server.stdout.on('data',bytes=>{logs+=bytes}); server.stderr.on('data',bytes=>{logs+=bytes})
    let exitCode
    server.on('exit',code=>{exitCode=code})
    try {
      const deadline=Date.now()+180000
      while (!existsSync(ready)) {
        if (exitCode!==undefined) throw new Error(`server exited ${exitCode}: ${logs}`)
        if (Date.now()>deadline) throw new Error('fixture readiness timeout')
        await delay(100)
      }
      await execute('node',[join(scriptRoot,'client.mjs'),ready,join(dir,'result.json'),mode,coding,scale==='smoke'?'2':'30'],
        {env:{...env,MEASUREMENT_SHA:sha}})
      const result=JSON.parse(readFileSync(join(dir,'result.json'),'utf8'))
      summary.push({run,arm,mode,coding,sha,wallMs:result.wallMs,mainBusyPercent:result.mainThreadBusyPercent,
        healthP95Ms:result.health.p95Ms,pingP95Ms:result.websocketPing.p95Ms,peakRssMiB:result.peakSampledServerRssBytes/1024/1024})
      writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n')
      console.table(summary)
    } finally {
      server.kill('SIGTERM')
      await new Promise(resolve=> { if(exitCode!==undefined) return resolve(); server.once('exit',resolve); setTimeout(()=>server.kill('SIGKILL'),2000).unref() })
      writeFileSync(join(dir,'server.log'),logs)
      for(const suffix of ['', '-wal','-shm']) rmSync(`${db}${suffix}`,{force:true})
    }
  }
}
