/**
 * Absolute path to a real Node.js binary for spawning Node-only children (tsx, Ink).
 *
 * Under bun --bun, Bun prepends a temporary bun-node shim dir to PATH with a node symlink
 * to bunx, so a bare "node" command re-enters Bun. Tests that need real Node (keyecho via
 * node --import tsx) must use an absolute path that is not a Bun shim. No-op under real Node:
 * returns process.execPath.
 *
 * Override: PODIUM_NODE_BIN=/path/to/node
 */

import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

function looksLikeBun(absPath: string): boolean {
  const lower = absPath.toLowerCase()
  return (
    lower.includes('/bun') ||
    lower.endsWith('/bunx') ||
    lower.includes('bun-node-') ||
    lower.includes('/.bun/')
  )
}

let cached: string | undefined

export function resolveNodeExecutable(): string {
  if (cached) return cached
  if (typeof process.versions.bun !== 'string') {
    cached = process.execPath
    return cached
  }
  const forced = process.env.PODIUM_NODE_BIN
  if (forced && existsSync(forced) && !looksLikeBun(realpathSync(forced))) {
    cached = forced
    return cached
  }
  // Skip Bun's injected shim dirs and .bun/bin so we find a real Node on PATH.
  const dirs = (process.env.PATH ?? '').split(':').filter((dir) => {
    if (!dir) return false
    const lower = dir.toLowerCase()
    return !lower.includes('bun-node-') && !lower.includes('/.bun/')
  })
  for (const dir of dirs) {
    const candidate = join(dir, 'node')
    if (!existsSync(candidate)) continue
    try {
      const real = realpathSync(candidate)
      if (looksLikeBun(real)) continue
      cached = candidate
      return cached
    } catch {
      continue
    }
  }
  throw new Error(
    'Real Node.js ≥ 22 not found on PATH (only Bun shims). ' +
      'Install Node or set PODIUM_NODE_BIN to its absolute path. ' +
      'Do not symlink node → bun (see README § Testing).',
  )
}
