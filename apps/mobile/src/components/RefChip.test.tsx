import type { IssueViewModel } from '@podium/client-core/replica'
import { ALL_ISSUE_STATUSES, ISSUE_STATUS_LABELS, isIssueStage } from '@podium/model'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { View as RNView } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { poolRouteFixture } from '../../test/pool-routes'
import { color } from '../theme/theme'

let issues: IssueViewModel[] = []
vi.mock('../client/use-inbox-data', () => ({
  usePoolRefChip: (token: string, kind: 'issue' | 'session', prefix: string) => {
    const fixture = poolRouteFixture({ issues, sessions: [] })
    try {
      return fixture.views.chip(token, kind, prefix)
    } finally {
      fixture.dispose()
    }
  },
}))

// The web build resolves react-native-svg's `.web.js` entry through Metro's
// platform extensions; this lane resolves the native one, which is Flow-typed
// source no transform here parses. Stub the drawing, keep the semantics — the
// glyph still announces its stage, which is the part a chip is asserting.
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Stub = (props: ComponentProps<typeof RNView>) => <View {...props} />
  return { default: Stub, Svg: Stub, Circle: Stub, Path: Stub, Rect: Stub, G: Stub }
})

const { RefChip } = await import('./RefChip')

function issue(seq: number, stage: IssueViewModel['stage']): IssueViewModel {
  return {
    id: `issue-${seq}`,
    seq,
    prefix: 'POD',
    displayRef: `POD-${seq}`,
    title: `Task ${seq}`,
    stage,
  } as IssueViewModel
}

/** A hex token as react-native-web normalises it into computed style. */
function inkOfToken(token: unknown): string {
  const n = Number.parseInt(String(token).replace('#', ''), 16)
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, 1.00)`
}

beforeEach(() => {
  issues = [issue(529, 'in_progress'), issue(676, 'done')]
})

describe('RefChip', () => {
  it.each(ALL_ISSUE_STATUSES)('announces the %s status from the live reference model', (status) => {
    issues = [
      {
        ...issue(2050, isIssueStage(status) ? status : 'done'),
        closedReason: isIssueStage(status) ? undefined : status,
      },
    ]
    const { container, unmount } = render(<RefChip token="POD-2050" refKind="issue" prefix="POD" />)
    const chip = container.querySelector('[aria-label*="task POD-2050"]')
    expect(chip?.getAttribute('aria-label')).toContain(ISSUE_STATUS_LABELS[status])
    unmount()
  })

  it('draws every ref as a quiet inline word in the label colour [POD-2380]', () => {
    const onPress = vi.fn()
    const { container } = render(
      <>
        <RefChip token="POD-529" refKind="issue" prefix="POD" onPress={onPress} />
        <RefChip token="POD-9999" refKind="issue" prefix="POD" />
        <RefChip token="POD-529-A" refKind="session" prefix="POD" />
      </>,
    )
    for (const label of [
      /In Progress task POD-529/i,
      /POD-9999 is unavailable/i,
      /Session POD-529-A/i,
    ]) {
      const node = screen.getByLabelText(label)
      expect(getComputedStyle(node).color).toBe(inkOfToken(color.text))
      expect(getComputedStyle(node).textDecorationLine).not.toBe('underline')
    }
    // No stage glyph (the old ring), no unresolved glyph.
    expect(container.querySelector('[aria-label="In Progress"]')).toBeNull()
    expect(container.querySelector('[aria-label="Unknown"]')).toBeNull()
    screen.getByLabelText(/In Progress task POD-529/i).click()
    expect(onPress).toHaveBeenCalledWith('POD-529')
  })

  it('leaves a ref-shaped token from an unknown prefix as prose', () => {
    // `anyRefMatcher` cannot tell `UTF-8` from `ACME-8`; the live projection can.
    const { container } = render(<RefChip token="UTF-8" refKind="issue" prefix="UTF" />)

    expect(container.textContent).toBe('UTF-8')
    expect(container.querySelector('[aria-label]')).toBeNull()
  })
})
