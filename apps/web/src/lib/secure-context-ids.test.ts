import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * NO RAW `crypto.randomUUID` IN CODE A BROWSER RUNS (POD-5931).
 *
 * Browsers expose `crypto.randomUUID` only in secure contexts. Podium is reached over plain
 * HTTP on LAN and Tailscale addresses, where it is undefined, and one raw call in the pool's
 * default mutation-id minter crashed every session pane opened there. `@podium/client-core/id`
 * is the safe spelling. The scanned set is DERIVED from apps/web's own workspace dependencies,
 * transitively, so a new browser package is covered without anyone adding it here.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const SAFE_HELPER = 'packages/client-core/src/id.ts'
/**
 * Directories inside a browser-reachable package that only the daemon runs. The harness's
 * agent drivers spawn and attach to CLI processes (node:child_process and friends), so a
 * browser bundle cannot contain them; Bun and Node always have crypto.randomUUID.
 */
const NODE_ONLY = ['packages/harness/src/driver/']

function workspacePackages(): Map<string, string> {
  const byName = new Map<string, string>()
  for (const group of ['packages', 'apps']) {
    for (const entry of readdirSync(join(ROOT, group))) {
      try {
        const pkg = JSON.parse(readFileSync(join(ROOT, group, entry, 'package.json'), 'utf8'))
        byName.set(pkg.name, join(group, entry))
      } catch {}
    }
  }
  return byName
}

function browserReachableDirs(): string[] {
  const packages = workspacePackages()
  const seen = new Set<string>()
  const queue = ['@podium/web']
  while (queue.length > 0) {
    const name = queue.shift() as string
    const dir = packages.get(name)
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys(pkg.dependencies ?? {})) if (packages.has(dep)) queue.push(dep)
  }
  return [...seen].map((dir) => join(dir, 'src'))
}

function sources(dir: string): string[] {
  const out: string[] = []
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(path, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec|bench)\.tsx?$/.test(entry) && !full.includes('test-support'))
        out.push(full)
    }
  }
  try {
    walk(join(ROOT, dir))
  } catch {}
  return out
}

describe('browser code mints ids without crypto.randomUUID', () => {
  it('scans the packages apps/web actually ships', () => {
    const dirs = browserReachableDirs()
    // A canary: the scan must reach the package that held the crash, or it proves nothing.
    expect(dirs).toContain('packages/client-graph/src')
    expect(dirs).toContain('apps/web/src')
  })

  it('finds no raw crypto.randomUUID call outside the safe helper', () => {
    const offenders = browserReachableDirs()
      .flatMap(sources)
      .map((file) => relative(ROOT, file))
      .filter((file) => file !== SAFE_HELPER && !NODE_ONLY.some((dir) => file.startsWith(dir)))
      .filter((file) => {
        const text = readFileSync(join(ROOT, file), 'utf8')
        // A guarded use (`typeof crypto.randomUUID === 'function'`) is a feature check, not a call.
        return /crypto\.randomUUID\(\)/.test(text) && !/typeof\s+crypto\.randomUUID\s*===\s*'function'/.test(text)
      })
    expect(offenders).toEqual([])
  })
})
