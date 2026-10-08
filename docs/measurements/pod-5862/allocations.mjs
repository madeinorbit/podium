/** Attribute sampled live allocations to creation stacks, not dominator size. */
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
const require = createRequire(resolve('apps/web/package.json'))
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping')
const [profilePath, dist] = process.argv.slice(2)
const { profile } = JSON.parse(readFileSync(profilePath, 'utf8'))
const maps = new Map(), owners = new Map()
function frame(raw) {
  const file = basename(raw.url ?? '')
  const path = join(dist, 'assets', file + '.map')
  if (!maps.has(path)) maps.set(path, existsSync(path) ? new TraceMap(JSON.parse(readFileSync(path, 'utf8'))) : null)
  const map = maps.get(path)
  const original = map && raw.lineNumber >= 0 ? originalPositionFor(map, {line: raw.lineNumber + 1, column: raw.columnNumber}) : null
  return original?.source ? `${original.source.replace(/^.*?(?=(?:apps|packages)\/)/,'')}:${original.line} ${original.name ?? raw.functionName}` : `${file}:${raw.lineNumber + 1} ${raw.functionName}`
}
function walk(node, stack) {
  const mapped = frame(node.callFrame), chain = [...stack, mapped]
  if (node.selfSize) {
    const owner = [...chain].reverse().find(at => /^(apps|packages)\//.test(at) && !at.startsWith('packages/mobx-helpers/')) ?? mapped
    owners.set(owner, (owners.get(owner) ?? 0) + node.selfSize)
  }
  for (const child of node.children ?? []) walk(child, chain)
}
walk(profile.head, [])
console.log(JSON.stringify({sampledLiveMiB: [...owners.values()].reduce((a,b)=>a+b,0)/2**20,
  creationOwners: [...owners].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([owner,bytes])=>({owner,KiB:Math.round(bytes/1024)}))},null,2))
