/** Serve a frozen production web directory against the live backend. */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
const webRequire=createRequire(resolve('apps/web/package.json'))
const { preview }=await import(webRequire.resolve('vite'))
const dist=resolve(process.argv[2])
const port=Number(process.argv[3]??55762)
const stamp=JSON.parse(readFileSync(resolve(dist,'podium-build.json'),'utf8'))
// The backend advertises its own served web assets. This private origin serves
// the frozen directory instead: advertise those bytes, with the backend's real
// wire/version identity intact. Never proxy its /podium-build.json over ours.
const identity={name:'frozen-memory-capture-identity',configurePreviewServer(s){s.middlewares.use(async(req,res,next)=>{
  const path=new URL(req.url,'http://localhost').pathname
  if(path!=='/version'&&path!=='/podium-build.json')return next()
  try {
    const value=path==='/podium-build.json'?stamp:await fetch('http://localhost:18787/version').then(r=>r.json()).then(v=>({...v,web:{...v.web,present:true,appVersion:stamp.appVersion,digest:stamp.sourceSha,bundle:stamp.bundleVersion}}))
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value))
  } catch {res.statusCode=502;res.end('Backend unavailable')}
})}}
const server=await preview({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),plugins:[identity],build:{outDir:dist},preview:{host:'127.0.0.1',port,strictPort:true}})
console.log(JSON.stringify({pid:process.pid,port,dist}))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await new Promise(r=>server.httpServer.close(r));process.exit(0)})
await new Promise(()=>{})
