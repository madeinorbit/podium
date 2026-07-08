import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isCompositionRoot, serverRoleOf } from '../roles'

/**
 * The core→hub import walker (docs/spec/node-hub-sync.md §2.4, roles manifest in
 * `../roles.ts`). Walks every .ts file under `srcDir` whose role is CORE and
 * reports any import/re-export that resolves into a hub-role path — the boundary
 * rule is "core never imports hub". Exemptions come from the manifest:
 * composition roots (server.ts/router.ts/index.ts — they ACTIVATE hub surfaces)
 * and test files (they may construct hub modules to inject them).
 *
 * The repo-wide lint (`scripts/check-boundaries.ts`) enforces the same rule —
 * plus the cloud tier — from the same manifest; this in-tree walker keeps the
 * rule enforced by the server's own vitest suite too.
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
      const rel = relative(srcDir, path).split('\\').join('/')
      if (serverRoleOf(rel) !== 'core') continue // hub may import core freely
      const st = statSync(path)
      if (st.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(name)) continue
      if (isCompositionRoot(rel)) continue // assembly may bridge roles
      if (/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(name)) continue // tests may inject hub modules
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
