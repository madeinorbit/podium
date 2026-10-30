import { describe, expect, it } from 'vitest'
import { markdownLinkFilePath } from './markdown-file-link'

describe('markdownLinkFilePath', () => {
  it.each([
    ['/home/me/site/docs/review.html', '/home/me/site/docs/review.html'],
    ['/Users/me/repo/src/app.ts:12:3', '/Users/me/repo/src/app.ts'],
    ['/abs/path/app.py:12', '/abs/path/app.py'],
    ['/repo/Makefile', '/repo/Makefile'],
    ['docs/notes.md#setup', 'docs/notes.md'],
    ['./scripts/run', './scripts/run'],
    ['../shared/a%20b.ts', '../shared/a b.ts'],
    ['file:///home/me/x.md', '/home/me/x.md'],
    ['file:///C:/Users/me/x.md', 'C:/Users/me/x.md'],
    ['C:/Users/me/x.md', 'C:/Users/me/x.md'],
    ['README.md:12', 'README.md'],
    ['app.ts:12:3', 'app.ts'],
    ['/repo/src/a.ts#L4-L9', '/repo/src/a.ts'],
    ['/home/me/notes', '/home/me/notes'],
    ['/tmp/run.log', '/tmp/run.log'],
  ])('reads %s as a file', (href, path) => {
    expect(markdownLinkFilePath(href, '/repo')).toBe(path)
  })

  it.each([
    'https://example.com/a.md',
    'mailto:me@example.com',
    'podium:issue/POD-1',
    '//cdn.example.com/a.js',
    '#heading',
    '/de/#pricing',
    '/de/guides/',
    '/issues/POD-12',
    '/workspace',
    '/file?path=/repo/a.ts',
    'file://otherhost/share/a.md',
    'docs/',
    '/de/pricing.html#plans',
    '/de/pricing.html',
    '/home/pricing',
    'de/pricing#plans',
    'localhost:3000',
    '/\\external.example/a.js',
    'ht\ntps://external.example/a.js',
  ])('leaves %s alone', (href) => {
    expect(markdownLinkFilePath(href, '/repo')).toBeNull()
  })

  it('lets Podium routes win over a cwd that contains them', () => {
    expect(markdownLinkFilePath('/workspace', '/workspace')).toBeNull()
    expect(markdownLinkFilePath('/issues/POD-2272', '/')).toBeNull()
    expect(markdownLinkFilePath('/workspace/README.md', '/workspace')).toBe('/workspace/README.md')
  })
})
