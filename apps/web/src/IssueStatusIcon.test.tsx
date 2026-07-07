import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IssueStatusIcon } from './IssueStatusIcon'

describe('IssueStatusIcon', () => {
  it('renders a neutral base glyph with the stage glyph badged in the corner', () => {
    const html = renderToStaticMarkup(<IssueStatusIcon stage="in_progress" />)
    // The corner badge is the StageGlyph, which exposes its stage via aria-label.
    expect(html).toContain('In Progress')
    // Two glyphs: the neutral base task icon + the small corner stage badge.
    expect(html.match(/<svg/g)?.length).toBe(2)
    // The base glyph reads neutral (muted-foreground), not stage-coloured.
    expect(html).toContain('text-muted-foreground')
  })

  it('reflects the given stage in the corner badge', () => {
    expect(renderToStaticMarkup(<IssueStatusIcon stage="done" />)).toContain('Done')
    expect(renderToStaticMarkup(<IssueStatusIcon stage="backlog" />)).toContain('Backlog')
  })
})
