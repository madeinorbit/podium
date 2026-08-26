// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import { setKnownPodiumOrigins } from './podium-link'

const HOME = 'http://127.0.0.1:8787'

afterEach(() => setKnownPodiumOrigins([]))

describe('a transcript link that points at this Podium (POD-1606)', () => {
  it('stays in the app instead of opening a browser tab', () => {
    setKnownPodiumOrigins([HOME])
    const html = renderMarkdown(`See [the issue](${HOME}/issues/POD-1606).`)
    expect(html).toContain('data-podium-link')
    expect(html).not.toContain('target="_blank"')
  })

  it('is recognised by the SERVER origin, not the page origin', () => {
    // The macOS shell renders this page from tauri://localhost. Registering the
    // server is the whole fix; without it the same link is someone else's.
    expect(renderMarkdown(`[x](${HOME}/issues/POD-1606)`)).toContain('target="_blank"')
    setKnownPodiumOrigins([HOME])
    expect(renderMarkdown(`[x](${HOME}/issues/POD-1606)`)).toContain('data-podium-link')
  })

  it('still sends a link to anywhere else to a new tab', () => {
    setKnownPodiumOrigins([HOME])
    const html = renderMarkdown('[docs](https://example.com/guide)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toContain('data-podium-link')
  })

  it('keeps a root-relative address in the app with no origin registered', () => {
    expect(renderMarkdown('[here](/issues/POD-1606)')).toContain('data-podium-link')
  })

  it('leaves ref chips and file links exactly as they were', () => {
    setKnownPodiumOrigins([HOME])
    const html = renderMarkdown('`apps/web/src/lib/markdown.ts`')
    expect(html).toContain('class="file-link"')
    expect(html).not.toContain('data-podium-link')
  })

  it('reads an href through the entities the sanitizer wrote', () => {
    setKnownPodiumOrigins([HOME])
    const html = renderMarkdown(`[f](${HOME}/file?path=%2Fw%2Fa.ts&root=%2Fw)`)
    // `&` is `&amp;` in the attribute; a resolver reading it raw would see a
    // query with no root and classify a real file address as a plain page.
    expect(html).toContain('&amp;')
    expect(html).toContain('data-podium-link')
  })
})
