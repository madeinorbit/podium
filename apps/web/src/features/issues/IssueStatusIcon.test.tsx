import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StageGlyph } from './issue-glyphs'
import { IssueStatusIcon } from './IssueStatusIcon'

const stylesPath = ['src/styles.css', 'apps/web/src/styles.css']
  .map((path) => resolve(process.cwd(), path))
  .find(existsSync)
const styles = readFileSync(stylesPath ?? 'src/styles.css', 'utf8')

describe('StageGlyph', () => {
  it('uses blue rather than obligation amber for in-progress work', () => {
    const html = renderToStaticMarkup(<StageGlyph stage="in_progress" />)

    expect(html).toContain('text-blue-500')
    expect(html).not.toContain('amber')
  })

  it('keeps markdown issue-reference progress glyphs on the same blue channel', () => {
    const selector = 'a.ref-link--issue[data-issue-stage="in_progress"] {'
    const start = styles.indexOf(selector)
    const end = styles.indexOf('\n}', start)
    const rule = styles.slice(start, end)

    expect(start, `${selector} not found in styles.css`).toBeGreaterThan(-1)
    expect(rule).toContain('rgb(59 130 246)')
    expect(rule).not.toContain('rgb(245 158 11)')
  })
})

describe('IssueStatusIcon', () => {
  it('renders a neutral base glyph with the stage glyph badged in the corner', () => {
    const html = renderToStaticMarkup(<IssueStatusIcon stage="in_progress" />)
    // The corner badge is the StageGlyph, which exposes its stage via aria-label.
    expect(html).toContain('In Progress')
    // Two glyphs: the neutral base task icon + the small corner stage badge.
    expect(html.match(/<svg/g)?.length).toBe(2)
  })

  it('reflects the given stage in the corner badge', () => {
    expect(renderToStaticMarkup(<IssueStatusIcon stage="done" />)).toContain('Done')
    expect(renderToStaticMarkup(<IssueStatusIcon stage="backlog" />)).toContain('Backlog')
  })
})
