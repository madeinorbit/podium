import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  committedFiles,
  extractAddresses,
  findEmailLeaks,
  formatEmailReport,
  isAllowedAddress,
  isGuardedPath,
} from './check-public-emails'

// Built at runtime so this file never holds a literal personal-looking address.
const planted = ['jane.doe', 'gmail.com'].join('@')

describe('check-public-emails', () => {
  const temps: string[] = []
  afterEach(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true })
    temps.length = 0
  })

  function tree(files: Record<string, string>): { root: string; paths: string[] } {
    const root = mkdtempSync(join(tmpdir(), 'public-emails-'))
    temps.push(root)
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), body)
    }
    return { root, paths: Object.keys(files) }
  }

  it('guards docs/, tests/, artifacts and any __fixtures__ directory, not source', () => {
    expect(isGuardedPath('docs/evidence/run.json')).toBe(true)
    expect(isGuardedPath('tests/e2e/x.spec.ts')).toBe(true)
    expect(isGuardedPath('artifacts/POD-1/a.html')).toBe(true)
    expect(isGuardedPath('.artifacts/x.log')).toBe(true)
    expect(isGuardedPath('packages/x/src/__fixtures__/capture.txt')).toBe(true)
    expect(isGuardedPath('apps/server/src/mail.ts')).toBe(false)
    expect(isGuardedPath('THIRD-PARTY-NOTICES.md')).toBe(false)
    expect(isGuardedPath('apps/docsite/src/__fixtures__')).toBe(false)
  })

  it('catches a planted address in a screen capture, with its line', () => {
    const { root, paths } = tree({
      'docs/evidence/screen.txt': `Claude Code\n  ${planted}'s Organization\n`,
      'apps/x/src/ok.ts': `const owner = '${planted}'\n`,
    })
    const hits = findEmailLeaks(root, paths)
    expect(hits).toEqual([{ path: 'docs/evidence/screen.txt', line: 2, address: planted }])
    expect(formatEmailReport(hits)).toContain(`docs/evidence/screen.txt:2: ${planted}`)
  })

  it('catches forms a screen wrap leaves behind, inside JSON and fixtures', () => {
    const { root, paths } = tree({
      'docs/m/run.json': JSON.stringify({ screen: `Welcome\\n${planted}` }),
      'packages/p/__fixtures__/pty.txt': `x${planted.slice(1)}\n`,
    })
    expect(findEmailLeaks(root, paths).map((h) => h.path)).toEqual([
      'docs/m/run.json',
      'packages/p/__fixtures__/pty.txt',
    ])
  })

  it('passes once the capture is redacted (fail-then-clean)', () => {
    const { root, paths } = tree({ 'docs/evidence/screen.txt': `${planted}'s Organization\n` })
    expect(findEmailLeaks(root, paths)).toHaveLength(1)
    writeFileSync(join(root, 'docs/evidence/screen.txt'), "person@example.com's Organization\n")
    expect(findEmailLeaks(root, paths)).toEqual([])
  })

  it('allows placeholders, noreply, SSH remotes and published contacts', () => {
    const published = new Set(['security@podium-contact.org'])
    for (const ok of [
      'person@example.com',
      'a@mail.example.org',
      'b@example.net',
      'x@host.test',
      'noreply@anthropic.com',
      '123+bot@users.noreply.github.com',
      'ply@anthropic.com',
      'git@github.com',
      'till@podium.do',
      'security@podium-contact.org',
    ]) {
      expect(isAllowedAddress(ok, published), ok).toBe(true)
    }
    for (const bad of [planted, 'someone@example.co', 'ops@notexample.com', 'y@anthropic.com']) {
      expect(isAllowedAddress(bad, published), bad).toBe(false)
    }
  })

  it('reads the published contacts from SECURITY.md', () => {
    const contact = ['security', 'contact-podium.dev'].join('@')
    const { root, paths } = tree({
      'SECURITY.md': `email <${contact}>\n`,
      'docs/x.md': `mail ${contact}\n`,
    })
    expect(findEmailLeaks(root, paths)).toEqual([])
  })

  it('ignores dotted identifiers and file names that only look like addresses', () => {
    const text = [
      'IssueModel@guard-root.ownAttentionSidebarFacts',
      'icon@2x.png',
      'react-native-worklets@0.10.0.patch',
      'user@1000.service',
      'pkg@HEAD.md',
    ].join('\n')
    expect(extractAddresses(text)).toEqual([])
    expect(extractAddresses(`a ${planted}.`)).toEqual([{ address: planted, line: 1 }])
  })

  it('passes the committed tree', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const hits = findEmailLeaks(repoRoot, committedFiles(repoRoot))
    expect(formatEmailReport(hits)).toBe(
      'ok: no e-mail addresses in committed docs, tests, artifacts or fixtures',
    )
  })
})
