import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The core→hub import walker (docs/spec/node-hub-sync.md §2.4). Walks every .ts
 * file under `srcDir` OUTSIDE `hub/` and reports any import/re-export that
 * resolves into `hub/` — the boundary rule is "core never imports hub", and this
 * cheap test-enforced walk is the whole enforcement mechanism (no lint plugin).
 *
 * Matches static `import`/`export ... from` and dynamic `import(...)` specifiers
 * that are relative paths containing a `hub/` segment (e.g. `./hub/pairing`,
 * `../hub/x`). Package imports can't reach hub/ (it isn't an export), so
 * relative specifiers are the only door.
 */
export function findCoreToHubImports(srcDir: string): string[] {
  const offenders: string[] = []
  const specifierRe = /(?:from\s+|import\s*\(\s*|import\s+)(['"])((?:\.{1,2}\/)[^'"]*)\1/g
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const rel = relative(srcDir, path)
      if (rel === 'hub' || rel.startsWith(`hub${'/'}`)) continue // hub may import anything
      const st = statSync(path)
      if (st.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(name)) continue
      const text = readFileSync(path, 'utf8')
      specifierRe.lastIndex = 0
      for (const m of text.matchAll(specifierRe)) {
        const spec = m[2] as string
        if (/(^|\/)hub(\/|$)/.test(spec)) {
          offenders.push(`${rel} imports ${spec}`)
        }
      }
    }
  }
  walk(srcDir)
  return offenders
}
