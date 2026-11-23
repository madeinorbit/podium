import { ExternalLink } from 'lucide-react'
import { type JSX, useMemo } from 'react'
import { renderReadoutMarkdown } from '@/lib/markdown'
import { UpdateScrollArea } from './UpdateCardParts'

/** Transform only sanitized readout HTML. Links in the Markdown remain inert. */
export function releaseNotesContent(summary?: string): { lede: string; body: string } {
  const root = document.createElement('div')
  root.innerHTML = summary ? renderReadoutMarkdown(summary.trim()) : ''
  const headline = [...root.children].find(
    (el) =>
      el.tagName === 'P' &&
      el.children.length === 1 &&
      el.firstElementChild?.tagName === 'STRONG' &&
      el.textContent === el.firstElementChild.textContent,
  )
  const lede = headline?.firstElementChild?.innerHTML ?? ''
  headline?.remove()
  const firstHeading = root.querySelector('h3')
  if (/^what[’']s new$/i.test(firstHeading?.textContent?.trim() ?? '')) firstHeading?.remove()

  // Leading bold terms form a definition list; unlabelled bullets retain their
  // list semantics and order. Subsequent sections stay ordinary Markdown lists.
  for (const block of [...root.children]) {
    if (/^H[1-6]$/.test(block.tagName)) break
    if (block.tagName !== 'UL') continue
    const result = document.createDocumentFragment()
    let list: HTMLElement | undefined
    for (const item of [...block.children]) {
      const owner = item.firstElementChild?.tagName === 'P' ? item.firstElementChild : item
      const first = owner.firstChild
      const term = first instanceof HTMLElement && first.tagName === 'STRONG' ? first : undefined
      if (term) {
        if (list?.tagName !== 'DL') {
          list = document.createElement('dl')
          result.append(list)
        }
        const row = document.createElement('div')
        const dt = document.createElement('dt')
        dt.innerHTML = term.innerHTML.replace(/\.\s*$/, '')
        term.remove()
        const dd = document.createElement('dd')
        dd.innerHTML = item.innerHTML.trim()
        row.append(dt, dd)
        list.append(row)
      } else {
        if (list?.tagName !== 'UL') {
          list = document.createElement('ul')
          result.append(list)
        }
        list.append(item)
      }
    }
    block.replaceWith(result)
  }
  return { lede, body: root.innerHTML }
}

export function ReleaseNotesLede({ html }: { html: string }): JSX.Element | null {
  return html ? (
    <div
      className="update-card-lede"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: extracted from renderReadoutMarkdown's sanitized, anchor-free output
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : null
}

export function ReleaseNotes({
  summary,
  url,
  showLede = false,
  onRead,
  labelledBy,
}: {
  summary?: string
  url?: string
  showLede?: boolean
  onRead?: () => void
  labelledBy?: string
}): JSX.Element {
  const content = useMemo(() => releaseNotesContent(summary), [summary])
  return (
    <section data-testid="update-notes" aria-label="Release notes" className="update-card-notes">
      {!labelledBy && (
        <div className="update-card-bar">
          <span className="update-card-section-label">What's new</span>
          {url && (
            <a data-testid="update-notes-link" href={url} target="_blank" rel="noreferrer">
              Release page <ExternalLink size={10} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
      <UpdateScrollArea onRead={onRead} labelledBy={labelledBy}>
        {showLede && <ReleaseNotesLede html={content.lede} />}
        {labelledBy && url && (
          <a
            className="update-card-release-link"
            data-testid="update-notes-link"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            Release page ↗
          </a>
        )}
        <div
          className="update-notes"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: releaseNotesContent only transforms sanitized renderReadoutMarkdown output
          dangerouslySetInnerHTML={{ __html: content.body }}
        />
      </UpdateScrollArea>
    </section>
  )
}
