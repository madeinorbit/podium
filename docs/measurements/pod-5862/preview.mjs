/** Serve a frozen production web directory against the live backend. */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const webRequire=createRequire(resolve('apps/web/package.json'))
const { preview }=await import(webRequire.resolve('vite'))
const dist=resolve(process.argv[2])
const port=Number(process.argv[3]??55762)
const server=await preview({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),build:{outDir:dist},preview:{host:'127.0.0.1',port,strictPort:true}})
console.log(JSON.stringify({pid:process.pid,port,dist}))
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await new Promise(r=>server.httpServer.close(r));process.exit(0)})
await new Promise(()=>{})
