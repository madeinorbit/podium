/**
 * Guard: no committed evidence or fixture file may carry a real e-mail address.
 *
 * Why: the repository is public, and agents commit raw terminal captures, status
 * dumps and measurement runs as evidence. Those captures carry whatever the
 * screen showed — a CLI's welcome banner prints the signed-in account's address,
 * a quota probe prints the account label — and such an address leaked into dozens
 * of files under docs/ that way before anyone noticed. History keeps it; this
 * guard stops the tree from gaining it again.
 *
 * Scope: committed files (`git ls-files`) under docs/, tests/, artifacts/,
 * .artifacts/ and any `__fixtures__` directory — the places evidence and captured
 * output land. Source code is out of scope: it carries addresses on purpose
 * (parsers, validators, licence notices).
 *
 * Allowed: example.com/.org/.net and their subdomains; the reserved TLDs
 * .example, .test, .invalid, .localhost and .local; noreply addresses (also a
 * noreply local part cut short by a screen wrap, e.g. `ply@…`); `git@github.com`,
 * which is an SSH remote, not a mailbox; and the addresses the project itself
 * publishes, read from SECURITY.md and CODE_OF_CONDUCT.md, plus its own domain.
 *
 * A token counts as an address only when its last label is a known TLD, so
 * dotted identifiers such as `IssueModel@guard-root.sidebar` or `icon@2x.png`
 * do not trip it.
 *
 * Run: `bun run lint:public-emails` (part of `bun run test` and `bun run lint`).
 * Fix a hit by redacting the capture: replace the address with
 * person@example.com and any account name beside it with a placeholder.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARDED_ROOTS = ['docs/', 'tests/', 'artifacts/', '.artifacts/'] as const
const PUBLISHING_FILES = ['SECURITY.md', 'CODE_OF_CONDUCT.md'] as const
const PROJECT_DOMAINS = ['podium.do'] as const
const NOT_A_MAILBOX = new Set(['git@github.com'])
const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost', 'local'])
const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'example.net'] as const

/**
 * Generic TLDs an address realistically uses. Every two-letter TLD is also
 * accepted (country codes), except the few that are far likelier to be a file
 * extension in captured output than a mail domain.
 */
const GENERIC_TLDS = new Set([
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'mil',
  'int',
  'info',
  'biz',
  'name',
  'pro',
  'mobi',
  'aero',
  'coop',
  'museum',
  'jobs',
  'travel',
  'tel',
  'asia',
  'cat',
  'app',
  'dev',
  'cloud',
  'email',
  'mail',
  'online',
  'site',
  'tech',
  'xyz',
  'page',
  'blog',
  'shop',
  'store',
  'live',
  'life',
  'world',
  'studio',
  'design',
  'space',
  'website',
  'news',
  'media',
  'agency',
  'digital',
  'network',
  'systems',
  'software',
  'solutions',
  'services',
  'company',
  'group',
  'team',
  'works',
  'zone',
  'one',
  'top',
  'club',
  'fun',
  'icu',
  'art',
  'berlin',
  'london',
  'paris',
  'tokyo',
  'nyc',
  'wiki',
  'ninja',
  'guru',
  'rocks',
  'codes',
  'build',
  'run',
  'social',
  'family',
  'academy',
  'consulting',
  'global',
  'inc',
  'llc',
  'ltd',
  'plus',
  'pub',
  'gmbh',
  'eu',
  'me',
  'ai',
  'io',
  'co',
  'tv',
  'cc',
])
const TWO_LETTER_EXTENSIONS = new Set([
  'js',
  'ts',
  'md',
  'py',
  'rs',
  'sh',
  'rb',
  'go',
  'cs',
  'gz',
  'xz',
  'db',
])

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/
const DOMAIN_CHAR = /[A-Za-z0-9.-]/

export type EmailHit = { path: string; line: number; address: string }

export function isGuardedPath(path: string): boolean {
  if (GUARDED_ROOTS.some((root) => path.startsWith(root))) return true
  return path.split('/').slice(0, -1).includes('__fixtures__')
}

/** Every address-shaped token in `text`, with the 1-based line it starts on. */
export function extractAddresses(text: string): { address: string; line: number }[] {
  const out: { address: string; line: number }[] = []
  let at = text.indexOf('@')
  while (at >= 0) {
    let start = at
    while (start > 0 && at - start < 64 && LOCAL_CHAR.test(text[start - 1] ?? '')) start--
    let end = at + 1
    while (end < text.length && end - at < 254 && DOMAIN_CHAR.test(text[end] ?? '')) end++
    const local = text.slice(start, at).replace(/^\.+/, '')
    const domain = text
      .slice(at + 1, end)
      .replace(/[.-]+$/, '')
      .toLowerCase()
    if (local.length > 0 && looksLikeMailDomain(domain)) {
      const line = text.slice(0, start).split('\n').length
      out.push({ address: `${local.toLowerCase()}@${domain}`, line })
    }
    at = text.indexOf('@', at + 1)
  }
  return out
}

function looksLikeMailDomain(domain: string): boolean {
  const labels = domain.split('.')
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return false
  const tld = labels[labels.length - 1] ?? ''
  if (!/^[a-z]+$/.test(tld)) return false
  if (RESERVED_TLDS.has(tld) || GENERIC_TLDS.has(tld)) return true
  return tld.length === 2 && !TWO_LETTER_EXTENSIONS.has(tld)
}

/** Addresses the project publishes as contacts, read from its own policy files. */
export function publishedAddresses(repoRoot: string): Set<string> {
  const out = new Set<string>()
  for (const name of PUBLISHING_FILES) {
    const file = join(repoRoot, name)
    if (!existsSync(file)) continue
    for (const { address } of extractAddresses(readFileSync(file, 'utf8'))) out.add(address)
  }
  return out
}

export function isAllowedAddress(address: string, published: ReadonlySet<string>): boolean {
  if (published.has(address) || NOT_A_MAILBOX.has(address)) return true
  const [local = '', domain = ''] = address.split('@')
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  if (RESERVED_TLDS.has(tld)) return true
  const underDomain = (d: string) => domain === d || domain.endsWith(`.${d}`)
  if (PLACEHOLDER_DOMAINS.some(underDomain) || PROJECT_DOMAINS.some(underDomain)) return true
  if (/no-?reply/.test(local) || /no-?reply/.test(domain)) return true
  // A noreply local part cut by a screen wrap (`ply@…`, `eply@…`).
  return local.length >= 3 && 'noreply'.endsWith(local)
}

/** Scan `paths` (repo-relative) under `repoRoot`; return every disallowed address. */
export function findEmailLeaks(repoRoot: string, paths: readonly string[]): EmailHit[] {
  const published = publishedAddresses(repoRoot)
  const hits: EmailHit[] = []
  for (const path of paths) {
    if (!isGuardedPath(path)) continue
    let buf: Buffer
    try {
      buf = readFileSync(join(repoRoot, path))
    } catch {
      continue
    }
    if (buf.subarray(0, 8000).includes(0)) continue
    for (const { address, line } of extractAddresses(buf.toString('utf8'))) {
      if (!isAllowedAddress(address, published)) hits.push({ path, line, address })
    }
  }
  return hits
}

export function committedFiles(repoRoot: string): string[] {
  const res = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (res.status !== 0) throw new Error(`git ls-files failed: ${res.stderr}`)
  return res.stdout.split('\0').filter(Boolean)
}

export function formatEmailReport(hits: readonly EmailHit[]): string {
  if (hits.length === 0)
    return 'ok: no e-mail addresses in committed docs, tests, artifacts or fixtures'
  return [
    `ERROR: ${hits.length} e-mail address(es) in committed evidence or fixture files.`,
    'The repository is public. Redact captures before committing them: replace the',
    'address with person@example.com and any account name beside it with a placeholder.',
    '',
    ...hits.map((h) => `  ${h.path}:${h.line}: ${h.address}`),
  ].join('\n')
}

function main(): number {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const hits = findEmailLeaks(repoRoot, committedFiles(repoRoot))
  const report = formatEmailReport(hits)
  if (hits.length > 0) {
    console.error(report)
    return 1
  }
  console.log(report)
  return 0
}

if (import.meta.main) {
  process.exit(main())
}
