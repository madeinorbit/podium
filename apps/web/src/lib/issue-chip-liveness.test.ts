import { describe, expect, it } from 'vitest'
import type { IssueReferenceModel } from '@podium/client-core/viewmodels'
import { decorateRefAnchors } from './issue-chip-liveness'

// LIVENESS IS AN ATTRIBUTE PASS, NOT A REWRITE (POD-1290 follow-up, the
// selection-death clock of 2026-08-19).
//
// The chip HTML is stable (see markdown.test.ts); what makes a chip LIVE —
// stage colour, availability, the accessible label — is written onto the
// existing anchors after each issue-store delta. Attribute writes destroy no
// nodes: a reader's text selection survives, rows never rebuild, and a fleet
// updating issues every few seconds costs one cheap sweep instead of a
// feed-wide innerHTML rewrite. This suite pins the two properties that
// matter: the anchors are decorated correctly, and they are the SAME DOM
// nodes afterwards.

function model(overrides: Partial<IssueReferenceModel> = {}): IssueReferenceModel {
  return {
    ref: 'POD-13',
    issueId: null,
    title: 'Ref chips',
    stage: 'in_progress',
    availability: 'present',
    accessibleLabel: 'POD-13 in progress',
    ...overrides,
  } as IssueReferenceModel
}

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('decorateRefAnchors', () => {
  it('writes live state onto known chips and leaves unknown ones bare', () => {
    const root = rootWith(
      '<a class="ref-link ref-link--issue" data-ref="POD-13">POD-13</a>' +
        '<a class="ref-link ref-link--issue" data-ref="POD-99">POD-99</a>',
    )
    decorateRefAnchors(root, new Map([['POD-13', model()]]))
    const [known, unknown] = Array.from(root.querySelectorAll('a'))
    expect(known?.getAttribute('data-issue-stage')).toBe('in_progress')
    expect(known?.getAttribute('data-issue-availability')).toBe('present')
    expect(known?.getAttribute('aria-label')).toBe('POD-13 in progress')
    expect(unknown?.hasAttribute('data-issue-stage')).toBe(false)
  })

  it('updates a changed stage on the SAME node — nothing is rebuilt', () => {
    const root = rootWith('<a class="ref-link ref-link--issue" data-ref="POD-13">POD-13</a>')
    const anchor = root.querySelector('a')
    decorateRefAnchors(root, new Map([['POD-13', model()]]))
    decorateRefAnchors(root, new Map([['POD-13', model({ stage: 'done' })]]))
    expect(root.querySelector('a')).toBe(anchor)
    expect(anchor?.getAttribute('data-issue-stage')).toBe('done')
  })

  it('removes liveness when an issue leaves the store', () => {
    const root = rootWith('<a class="ref-link ref-link--issue" data-ref="POD-13">POD-13</a>')
    decorateRefAnchors(root, new Map([['POD-13', model()]]))
    decorateRefAnchors(root, new Map())
    const anchor = root.querySelector('a')
    expect(anchor?.hasAttribute('data-issue-stage')).toBe(false)
    expect(anchor?.hasAttribute('aria-label')).toBe(false)
  })

  it('does not touch session chips or plain links', () => {
    const root = rootWith(
      '<a class="ref-link ref-link--session" data-ref="SES-2">SES-2</a><a href="https://x">x</a>',
    )
    decorateRefAnchors(root, new Map([['SES-2', model({ ref: 'SES-2' })]]))
    for (const a of Array.from(root.querySelectorAll('a'))) {
      expect(a.hasAttribute('data-issue-stage')).toBe(false)
    }
  })
})
