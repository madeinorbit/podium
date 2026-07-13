/**
 * Generate THIRD-PARTY-NOTICES.md — the license inventory for Podium's shipped artifacts.
 *
 * Walks bun.lock starting from the production dependencies of the shipped apps
 * (apps/server, apps/daemon, apps/web, apps/cli) through workspace packages, collecting
 * every reachable external npm package (dependencies + optionalDependencies + resolvable
 * peerDependencies; devDependencies excluded). For each package it reads the installed
 * package.json (license, author) and LICENSE file (copyright lines) from the bun store,
 * then emits THIRD-PARTY-NOTICES.md at the repo root, including a hand-maintained
 * "Vendored code" section.
 *
 * Usage:
 *   bun scripts/generate-third-party-notices.ts           # (re)write THIRD-PARTY-NOTICES.md
 *   bun scripts/generate-third-party-notices.ts --check   # also fail (exit 1) on copyleft or
 *                                                         # unknown licenses in prod deps
 *
 * Platform note: optional platform-variant packages (lock entries with os/cpu constraints)
 * that are not installed on this machine are skipped — they are prebuilt binaries of an
 * included base package and carry the same license. This keeps output deterministic on the
 * linux-x64 CI runner that regenerates + diffs this file.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Shipped artifacts whose prod dep graphs define the notice scope. */
const SHIPPED_WORKSPACES = ['apps/server', 'apps/daemon', 'apps/web', 'apps/cli']

/** SPDX ids (case-insensitive) allowed in production dependencies. */
export const LICENSE_ALLOWLIST = new Set(
  [
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'Python-2.0',
    'BlueOak-1.0.0',
    // common aliases seen in the wild for allowed licenses
    'Apache 2.0',
    'Apache License 2.0',
    'MIT/X11',
    'CC-BY-4.0', // docs/data attribution license, permissive
  ].map((s) => s.toLowerCase()),
)

const COPYLEFT_MARKERS = ['gpl', 'agpl', 'lgpl', 'sspl', 'eupl', 'cddl', 'epl', 'mpl']

/**
 * Explicit per-package exceptions to the SPDX allowlist. Each entry is a REVIEWED decision
 * with its justification — never add here to silence CI without reading the license.
 * These packages are surfaced in THIRD-PARTY-NOTICES.md with their real license.
 */
export const PACKAGE_EXCEPTIONS: Record<string, string> = {
  // Proprietary Anthropic license ("© Anthropic PBC. All rights reserved", use subject to
  // https://code.claude.com/docs/en/legal-and-compliance). NOT open source. The daemon
  // depends on it to host Claude sessions; redistribution in Podium bundles relies on
  // Anthropic's Commercial/Consumer Terms permitting SDK use. Flagged during #21 review.
  '@anthropic-ai/claude-agent-sdk': 'proprietary Anthropic SDK license — reviewed 2026-07',
  '@anthropic-ai/claude-agent-sdk-linux-x64': 'platform binary of @anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl':
    'platform binary of @anthropic-ai/claude-agent-sdk',
  // MPL-2.0 is FILE-level weak copyleft: using the unmodified npm packages in a larger
  // Apache-2.0 work is permitted; obligations only attach if we modify MPL-covered files
  // (we don't — plain npm consumers). Reviewed 2026-07 during #21.
  '@blocknote/core': 'MPL-2.0, consumed unmodified from npm (file-level copyleft only)',
  '@blocknote/react': 'MPL-2.0, consumed unmodified from npm (file-level copyleft only)',
  '@blocknote/mantine': 'MPL-2.0, consumed unmodified from npm (file-level copyleft only)',
  // SIL Open Font License 1.1 — the standard permissive license for font files; imposes
  // no obligations on the embedding application.
  '@fontsource-variable/geist': 'OFL-1.1 font package',
  '@fontsource-variable/geist-mono': 'OFL-1.1 font package',
}

// ---------------------------------------------------------------------------------------
// bun.lock parsing (JSONC: tolerate trailing commas)

type LockPkgEntry = [
  resolution: string, // "name@version"
  registry: string,
  meta: {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalPeers?: string[]
    os?: string | string[]
    cpu?: string | string[]
  },
  integrity?: string,
]

interface Lockfile {
  workspaces: Record<
    string,
    {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
  >
  packages: Record<string, LockPkgEntry>
}

function readLockfile(): Lockfile {
  const raw = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
  // bun.lock is JSONC (trailing commas). Strip them outside of strings.
  const stripped = raw.replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(stripped) as Lockfile
}

// ---------------------------------------------------------------------------------------
// Dependency graph walk

interface Dep {
  name: string
  version: string
  lockKey: string
  installed: boolean
  license: string
  copyright: string[]
  homepage?: string
}

function lockKeyFor(
  lock: Lockfile,
  depName: string,
  parentKey: string | undefined,
): string | undefined {
  // bun.lock nests conflicting versions under "parent/dep" keys; prefer the most specific.
  if (parentKey) {
    const nested = `${parentKey}/${depName}`
    if (lock.packages[nested]) return nested
  }
  if (lock.packages[depName]) return depName
  // Fall back to any nested entry for this name (license-wise versions rarely differ).
  const suffix = `/${depName}`
  for (const k of Object.keys(lock.packages)) if (k.endsWith(suffix)) return k
  return undefined
}

/** Locate the installed package dir: bun isolated store first, then hoisted node_modules. */
function findInstallDir(name: string, version: string): string | undefined {
  const storeName = name.replace('/', '+')
  const store = join(ROOT, 'node_modules', '.bun')
  if (existsSync(store)) {
    const exact = join(store, `${storeName}@${version}`, 'node_modules', name)
    if (existsSync(join(exact, 'package.json'))) return exact
    // peer-suffixed store entries: "<name>@<version>+<hash>"
    try {
      for (const entry of readdirSync(store)) {
        if (entry.startsWith(`${storeName}@${version}+`)) {
          const dir = join(store, entry, 'node_modules', name)
          if (existsSync(join(dir, 'package.json'))) return dir
        }
      }
    } catch {
      /* ignore */
    }
  }
  const hoisted = join(ROOT, 'node_modules', name)
  if (existsSync(join(hoisted, 'package.json'))) return hoisted
  return undefined
}

function normalizeLicense(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object') {
    const o = raw as { type?: string }
    if (typeof o.type === 'string') return o.type.trim()
  }
  if (Array.isArray(raw)) {
    const types = raw
      .map((l) => (typeof l === 'string' ? l : (l as { type?: string })?.type))
      .filter(Boolean)
    if (types.length) return `(${types.join(' OR ')})`
  }
  return 'UNKNOWN'
}

function extractCopyright(dir: string): string[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
  } catch {
    return []
  }
  const lines: string[] = []
  for (const f of files.slice(0, 2)) {
    try {
      const text = readFileSync(join(dir, f), 'utf8')
      for (const line of text.split('\n')) {
        const t = line.replace(/^[\s#*/-]+/, '').trim()
        if (/^copyright\b/i.test(t) && t.length < 200) {
          lines.push(t)
          if (lines.length >= 3) return lines
        }
      }
    } catch {
      /* ignore */
    }
  }
  return lines
}

function collectDeps(lock: Lockfile): Dep[] {
  // Seed: prod deps of shipped workspaces; expand workspace:* through workspace prod deps.
  const workspaceByName = new Map<string, string>()
  for (const [path, ws] of Object.entries(lock.workspaces))
    if (ws.name) workspaceByName.set(ws.name, path)

  const seedNames = new Set<string>()
  const wsQueue = [...SHIPPED_WORKSPACES]
  const wsSeen = new Set<string>()
  while (wsQueue.length) {
    const path = wsQueue.pop()
    if (path === undefined || wsSeen.has(path)) continue
    wsSeen.add(path)
    const ws = lock.workspaces[path]
    if (!ws)
      throw new Error(`generate-third-party-notices: workspace ${path} missing from bun.lock`)
    for (const [dep, range] of Object.entries(ws.dependencies ?? {})) {
      if (range.startsWith('workspace:')) {
        const wsPath = workspaceByName.get(dep)
        if (wsPath === undefined) throw new Error(`workspace dep ${dep} not found`)
        wsQueue.push(wsPath)
      } else {
        seedNames.add(dep)
      }
    }
  }

  const found = new Map<string, Dep>() // by lockKey
  const queue: Array<{ name: string; parentKey?: string }> = [...seedNames].map((name) => ({
    name,
  }))
  const queued = new Set<string>()

  while (queue.length) {
    const item = queue.pop()
    if (!item) break
    const key = lockKeyFor(lock, item.name, item.parentKey)
    if (key === undefined) {
      // unresolvable peer dep (not installed) — skip
      continue
    }
    if (found.has(key)) continue
    const entry = lock.packages[key]
    if (!entry) continue
    const [resolution, , meta] = entry
    const at = resolution.lastIndexOf('@')
    const name = resolution.slice(0, at)
    const version = resolution.slice(at + 1)

    const dir = findInstallDir(name, version)
    const platformScoped = meta.os !== undefined || meta.cpu !== undefined
    if (!dir && platformScoped) {
      // Not installed on this platform: prebuilt variant of an included base package. Skip.
      continue
    }

    let license = 'UNKNOWN'
    let copyright: string[] = []
    let homepage: string | undefined
    if (dir) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<
          string,
          unknown
        >
        license = normalizeLicense(pkg.license ?? pkg.licenses)
        homepage = typeof pkg.homepage === 'string' ? pkg.homepage : undefined
        copyright = extractCopyright(dir)
        if (copyright.length === 0 && typeof pkg.author === 'string')
          copyright = [`Copyright ${pkg.author}`]
        else if (copyright.length === 0 && pkg.author && typeof pkg.author === 'object') {
          const a = pkg.author as { name?: string }
          if (a.name) copyright = [`Copyright ${a.name}`]
        }
      } catch {
        /* keep UNKNOWN */
      }
    }

    found.set(key, {
      name,
      version,
      lockKey: key,
      installed: Boolean(dir),
      license,
      copyright,
      homepage,
    })

    const optionalPeers = new Set(meta.optionalPeers ?? [])
    const next = [
      ...Object.keys(meta.dependencies ?? {}),
      ...Object.keys(meta.optionalDependencies ?? {}),
      ...Object.keys(meta.peerDependencies ?? {}).filter((p) => !optionalPeers.has(p)),
    ]
    for (const dep of next) {
      const qk = `${key}>>${dep}`
      if (!queued.has(qk)) {
        queued.add(qk)
        queue.push({ name: dep, parentKey: key })
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

// ---------------------------------------------------------------------------------------
// License policy check

/** true if a single SPDX id is allowed. */
function idAllowed(id: string): boolean {
  return LICENSE_ALLOWLIST.has(id.trim().toLowerCase())
}

/**
 * Evaluate an SPDX expression against the allowlist: OR = any branch allowed,
 * AND = all parts allowed. Anything unparsable = not allowed.
 */
export function licenseAllowed(expr: string): boolean {
  const cleaned = expr.replace(/[()]/g, ' ').trim()
  if (!cleaned || cleaned === 'UNKNOWN') return false
  if (/\bOR\b/i.test(cleaned)) return cleaned.split(/\bOR\b/i).some((p) => licenseAllowed(p))
  if (/\bAND\b/i.test(cleaned)) return cleaned.split(/\bAND\b/i).every((p) => licenseAllowed(p))
  return idAllowed(cleaned)
}

function isCopyleft(expr: string): boolean {
  if (licenseAllowed(expr)) return false
  const lower = expr.toLowerCase()
  return COPYLEFT_MARKERS.some((m) => lower.includes(m))
}

// ---------------------------------------------------------------------------------------
// Output

const VENDORED_SECTION = `## Vendored code

The following third-party sources are vendored (copied) into this repository:

### abduco

- Path: \`packages/agent-bridge/vendor/abduco/\`
- Upstream: https://github.com/martanne/abduco (v0.6, commit 8c32909)
- License: ISC — Copyright (c) 2013-2018 Marc André Tanner. See
  \`packages/agent-bridge/vendor/abduco/LICENSE\` for the full text.
- Podium compiles abduco at build time and embeds the binary in the compiled daemon as
  its durable PTY session backend. Local changes: none (see the accompanying VENDOR.md).
`

function render(deps: Dep[]): string {
  const byLicense = new Map<string, number>()
  for (const d of deps) byLicense.set(d.license, (byLicense.get(d.license) ?? 0) + 1)
  const summary = [...byLicense.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lic, n]) => `| ${lic} | ${n} |`)
    .join('\n')

  const rows = deps
    .map((d) => {
      const parts = [`### ${d.name}@${d.version}`, '', `- License: ${d.license}`]
      for (const c of d.copyright) parts.push(`- ${c}`)
      if (d.homepage) parts.push(`- ${d.homepage}`)
      return parts.join('\n')
    })
    .join('\n\n')

  return `# Third-party notices

Podium is licensed under the Apache License 2.0 (see LICENSE). It ships with the
following third-party open-source components. This file is generated by
\`bun scripts/generate-third-party-notices.ts\` from the production dependency graphs of
the shipped artifacts (server, daemon, web, cli) in bun.lock — do not edit by hand.

Platform-specific prebuilt variants of listed packages (e.g. \`@esbuild/<platform>\`) that
are not installed on the generating platform carry the same license as their listed base
package and are omitted.

## License summary

| License | Packages |
| --- | --- |
${summary}

${VENDORED_SECTION}
## npm packages

${rows}
`
}

function main(): void {
  const check = process.argv.includes('--check')
  const lock = readLockfile()
  const deps = collectDeps(lock)

  writeFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), render(deps))
  console.log(`[third-party-notices] ${deps.length} packages -> THIRD-PARTY-NOTICES.md`)

  const excepted = deps.filter((d) => !licenseAllowed(d.license) && d.name in PACKAGE_EXCEPTIONS)
  for (const d of excepted)
    console.log(
      `[third-party-notices] exception: ${d.name}@${d.version} (${d.license}) — ${PACKAGE_EXCEPTIONS[d.name]}`,
    )
  const bad = deps.filter((d) => !licenseAllowed(d.license) && !(d.name in PACKAGE_EXCEPTIONS))
  if (bad.length) {
    const label = (d: Dep): string =>
      `${d.name}@${d.version}: ${d.license}${isCopyleft(d.license) ? ' (COPYLEFT)' : ''}`
    const msg = [
      `[third-party-notices] ${bad.length} production dependencies with disallowed or unknown licenses:`,
      ...bad.map((d) => `  - ${label(d)}`),
      'Allowed: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense, CC0-1.0, Python-2.0, BlueOak-1.0.0.',
      'If a license is a permissive variant, extend LICENSE_ALLOWLIST in scripts/generate-third-party-notices.ts',
      'with a comment justifying it; copyleft (GPL/AGPL/LGPL/SSPL/…) dependencies must be removed or replaced.',
    ].join('\n')
    if (check) {
      console.error(msg)
      process.exit(1)
    } else {
      console.warn(msg)
    }
  } else {
    console.log(
      excepted.length
        ? `[third-party-notices] licenses OK (${excepted.length} reviewed exceptions above)`
        : '[third-party-notices] all production dependency licenses are on the allowlist',
    )
  }
}

if (import.meta.main) main()
