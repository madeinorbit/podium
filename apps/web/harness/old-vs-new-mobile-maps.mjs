/** Build matching analysis maps without replacing the measured mobile assets. */
import {execFileSync} from 'node:child_process'
import {readFileSync,readdirSync,copyFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {hostname} from 'node:os'
if(hostname()!=='flatblock')throw Error('Build analysis maps in the dedicated flatblock checkout')
const root=process.cwd(), output=resolve('.artifacts/old-vs-new/mobile-maps')
mkdirSync(output,{recursive:true})
if(!process.argv.includes('--install-only'))execFileSync(resolve('.toolchain/bun'),[resolve('apps/mobile/node_modules/expo/bin/cli'),'export','-p','web','--dump-sourcemap','--output-dir',output],{
  cwd:resolve('apps/mobile'),env:{...process.env,EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH:'1',EXPO_UNSTABLE_TREE_SHAKING:'1'},stdio:'inherit'
})
const files=path=>readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(resolve(path,entry.name)):[resolve(path,entry.name)])
const clean=path=>readFileSync(path,'utf8').replace(/\n?\/\/# (?:sourceMappingURL|debugId)=.*$/mg,'').trimEnd()
const built=files(output).filter(path=>path.endsWith('.js'))
const recorded=[]
for(const path of files(resolve('apps/mobile/dist')).filter(path=>path.endsWith('.js'))) {
  const bytes=clean(path), candidate=built.find(other=>clean(other)===bytes)
  if(!candidate)throw Error('Analysis bundle differs from measured bundle: '+path)
  const map=candidate+'.map'
  copyFileSync(map,path+'.map')
  recorded.push({asset:relative(root,path),map:relative(root,path+'.map'),sha256:createHash('sha256').update(bytes).digest('hex')})
}
writeFileSync(resolve(output,'verified-assets.json'),JSON.stringify(recorded,null,2)+'\n')
console.log(`Verified and installed ${recorded.length} analysis maps; measured JS untouched`)
