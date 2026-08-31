// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import {
  canonicalizePodiumAnchors,
  internalPodiumTarget,
  setKnownPodiumOrigins,
} from './podium-link'

const HOME = 'http://127.0.0.1:8787'
const OTHER = 'http://127.0.0.1:9898'

afterEach(() => {
  setKnownPodiumOrigins([])
  document.body.innerHTML = ''
})

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
    expect(html).toContain('data-podium-link-candidate')
    expect(html).not.toContain('data-podium-link=""')
  })

  it('keeps a root-relative address in the app with no origin registered', () => {
    expect(renderMarkdown('[here](/issues/POD-1606)')).toContain('data-podium-link')
  })

  it('renders a hostless address against the active server rather than the page origin', () => {
    expect(window.location.origin).not.toBe(HOME)
    setKnownPodiumOrigins([HOME])
    const html = renderMarkdown('[here](/issues/POD-1606)')
    expect(html).toContain(`href="${HOME}/issues/POD-1606"`)
  })

  it('rebases boot-rendered active-server anchors after the origin becomes known', () => {
    expect(window.location.origin).not.toBe(HOME)
    document.body.innerHTML = `${renderMarkdown(
      `[here](${HOME}/issues/POD-1606)`,
    )}<a id="app-chrome" href="/settings">settings</a>`
    const link = document.querySelector('a[data-podium-link-candidate]') as HTMLAnchorElement
    const appChrome = document.querySelector('#app-chrome') as HTMLAnchorElement
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.hasAttribute('data-podium-link')).toBe(false)
    setKnownPodiumOrigins([HOME])
    canonicalizePodiumAnchors(document)
    expect(link.href).toBe(`${HOME}/issues/POD-1606`)
    expect(link.getAttribute('target')).toBeNull()
    expect(link.hasAttribute('data-podium-link')).toBe(true)
    expect(appChrome.getAttribute('href')).toBe('/settings')
    expect(appChrome.hasAttribute('data-podium-link')).toBe(false)
  })

  it('restores external fallback when the active server changes', () => {
    setKnownPodiumOrigins([HOME])
    document.body.innerHTML = renderMarkdown(`[here](${HOME}/issues/POD-1606)`)
    const link = document.querySelector('a') as HTMLAnchorElement
    expect(link.hasAttribute('data-podium-link')).toBe(true)
    expect(link.getAttribute('target')).toBeNull()

    setKnownPodiumOrigins([OTHER])
    canonicalizePodiumAnchors(document)
    expect(link.href).toBe(`${HOME}/issues/POD-1606`)
    expect(link.hasAttribute('data-podium-link')).toBe(false)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('leaves ref chips and file links exactly as they were', () => {
    setKnownPodiumOrigins([HOME])
    const html = renderMarkdown('`apps/web/src/lib/markdown.ts`')
    expect(html).toContain('class="file-link"')
    expect(html).not.toContain('data-podium-link')
  })

  it('reads an href through the entities the sanitizer wrote', () => {
    setKnownPodiumOrigins([HOME])
    const href = `${HOME}/file?path=%2Fw%2Fa.ts&root=%2Fw`
    const html = renderMarkdown(`[f](${href})`)
    // `&` is `&amp;` in the attribute. Asserting only that the anchor is marked
    // proves nothing: URLSearchParams still finds `path` in `?path=…&amp;root=…`,
    // so the target is `file` either way and only `root` is lost. Root is the
    // assertion that fails without the entity decode.
    expect(html).toContain('&amp;')
    expect(internalPodiumTarget(href)).toEqual({
      kind: 'file',
      path: '/w/a.ts',
      root: '/w',
      machineId: null,
    })
  })
})
