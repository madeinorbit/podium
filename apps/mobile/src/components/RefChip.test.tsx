import type { IssueWire } from '@podium/model'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { View as RNView } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STAGE_COLOR, STAGE_UNKNOWN } from '../theme/stage'
import { color } from '../theme/theme'

let issues: IssueWire[] = []
vi.mock('../client/hooks', () => ({ useIssues: () => issues }))

// The web build resolves react-native-svg's `.web.js` entry through Metro's
// platform extensions; this lane resolves the native one, which is Flow-typed
// source no transform here parses. Stub the drawing, keep the semantics — the
// glyph still announces its stage, which is the part a chip is asserting.
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Stub = (props: ComponentProps<typeof RNView>) => <View {...props} />
  return { default: Stub, Svg: Stub, Circle: Stub, Path: Stub, Rect: Stub }
})

const { RefChip } = await import('./RefChip')

function issue(seq: number, stage: IssueWire['stage']): IssueWire {
  return {
    id: `issue-${seq}`,
    seq,
    prefix: 'POD',
    displayRef: `POD-${seq}`,
    title: `Task ${seq}`,
    stage,
  } as IssueWire
}

function inkOf(label: RegExp): string {
  return getComputedStyle(screen.getByLabelText(label)).color
}

/** The hex token as react-native-web normalises it into computed style. */
function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, 1.00)`
}

beforeEach(() => {
  issues = [issue(529, 'in_progress'), issue(676, 'done')]
})

describe('RefChip', () => {
  it('paints a resolved ref in its live workflow stage [POD-724]', () => {
    render(<RefChip token="POD-529" refKind="issue" prefix="POD" onPress={vi.fn()} />)

    expect(inkOf(/In Progress task POD-529/i)).toBe(rgb(STAGE_COLOR.in_progress))
    // …and carries the stage's shape, not only its colour.
    expect(screen.getByLabelText('In progress')).toBeTruthy()
  })

  it('leaves a ref with no live row muted rather than guessing [POD-676]', () => {
    // A parseable token whose row has not arrived (or is not visible to this
    // principal) must not borrow a stage colour, and must never take the brand
    // accent — that would read as "waiting on you".
    const { container } = render(
      <RefChip token="POD-9999" refKind="issue" prefix="POD" onPress={vi.fn()} />,
    )

    expect(inkOf(/POD-9999 is unavailable/i)).toBe(rgb(STAGE_UNKNOWN))
    expect(inkOf(/POD-9999 is unavailable/i)).not.toBe(rgb(color.accent))
    // …and SAYS unresolved rather than only going quiet: `backlog` is muted
    // too, so grey alone left the two states one indistinguishable colour.
    expect(container.querySelector('[aria-label="Unknown"]')).toBeTruthy()
  })

  it('never paints a session ref with a workflow stage', () => {
    // Scoped to this render's own container, not `screen`: renders in this file
    // accumulate in the document, so a document-wide query would find the
    // previous test's glyph.
    const { container } = render(<RefChip token="POD-529-A" refKind="session" prefix="POD" />)

    expect(inkOf(/Session POD-529-A/i)).toBe(rgb(color.textDim))
    // A session ref is not a task whose state we failed to learn, so it gets no
    // unknown glyph — that would claim a gap that is not there.
    expect(container.querySelector('[aria-label="Unknown"]')).toBeNull()
  })

  it('leaves a ref-shaped token from an unknown prefix as prose', () => {
    // `anyRefMatcher` cannot tell `UTF-8` from `ACME-8`; the live projection can.
    const { container } = render(<RefChip token="UTF-8" refKind="issue" prefix="UTF" />)

    expect(container.textContent).toBe('UTF-8')
    expect(container.querySelector('[aria-label]')).toBeNull()
  })
})
