import type { IssueViewModel } from '@podium/client-core/replica'
import { ALL_ISSUE_STATUSES, ISSUE_STATUS_LABELS, isIssueStage } from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { View as RNView } from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { poolRouteFixture } from '../../test/pool-routes'

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

vi.mock('../lib/podium-link', () => ({ openPodiumTarget: vi.fn() }))

const { RefChip } = await import('./RefChip')
const { openPodiumTarget } = await import('../lib/podium-link')

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

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(openPodiumTarget).mockClear()
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

  it('draws every known ref as a chip with its stage, unknown or session glyph [POD-2444]', () => {
    render(
      <>
        <RefChip token="POD-529" refKind="issue" prefix="POD" />
        <RefChip token="POD-9999" refKind="issue" prefix="POD" />
        <RefChip token="POD-529-A" refKind="session" prefix="POD" />
      </>,
    )
    for (const label of [
      /In Progress task POD-529/i,
      /POD-9999 is unavailable/i,
      /Session POD-529-A/i,
    ]) {
      const chip = screen.getByLabelText(label)
      expect(chip.getAttribute('role')).toBe('link')
      // A filled capsule at the control corner, not a bare word or a pill.
      expect(getComputedStyle(chip).borderTopLeftRadius).toBe('6px')
      expect(getComputedStyle(chip).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    }
    // Live stage glyph on the resolved task; question ring on the gap only.
    expect(
      screen
        .getByLabelText(/In Progress task POD-529/i)
        .querySelector('[aria-label="In Progress"]'),
    ).not.toBeNull()
    expect(
      screen.getByLabelText(/POD-9999 is unavailable/i).querySelector('[aria-label="Unknown"]'),
    ).not.toBeNull()
    expect(
      screen.getByLabelText(/Session POD-529-A/i).querySelector('[aria-label="Unknown"]'),
    ).toBeNull()
  })

  it('peeks an issue through the handler, else opens it through the link activator', () => {
    const onPress = vi.fn()
    render(
      <>
        <RefChip token="POD-529" refKind="issue" prefix="POD" onPress={onPress} />
        <RefChip token="POD-676" refKind="issue" prefix="POD" />
      </>,
    )
    fireEvent.click(screen.getByLabelText(/task POD-529/i))
    expect(onPress).toHaveBeenCalledWith('POD-529')
    expect(openPodiumTarget).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(/task POD-676/i))
    expect(openPodiumTarget).toHaveBeenCalledWith({ kind: 'issue', issue: 'POD-676' })
  })

  it('opens a session ref as a session even when an issue handler is given', () => {
    const onPress = vi.fn()
    render(<RefChip token="POD-529-A" refKind="session" prefix="POD" onPress={onPress} />)
    fireEvent.click(screen.getByLabelText(/Session POD-529-A/i))
    expect(onPress).not.toHaveBeenCalled()
    expect(openPodiumTarget).toHaveBeenCalledWith({ kind: 'session', session: 'POD-529-A' })
  })

  it('leaves a ref-shaped token from an unknown prefix as prose', () => {
    // `anyRefMatcher` cannot tell `UTF-8` from `ACME-8`; the live projection can.
    const { container } = render(<RefChip token="UTF-8" refKind="issue" prefix="UTF" />)

    expect(container.textContent).toBe('UTF-8')
    expect(container.querySelector('[aria-label]')).toBeNull()
  })
})
