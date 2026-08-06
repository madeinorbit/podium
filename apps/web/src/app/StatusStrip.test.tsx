// @vitest-environment happy-dom
import { asIssueId } from '@podium/model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'

const fixture = vi.hoisted(() => ({
  issue: null as ReturnType<typeof makeIssue> | null,
}))

vi.mock('./store', () => ({
  useReplicaIssues: () => (fixture.issue ? [fixture.issue] : []),
  useStoreSelector: (selector: (store: unknown) => unknown) =>
    selector({
      sessions: [],
      selectedIssueId: fixture.issue?.id,
      paletteOpen: false,
      setPaletteOpen: vi.fn(),
    }),
}))

vi.mock('@/features/machines/ConnectionIndicator', () => ({
  ConnectionIndicator: () => null,
  useStableConnection: () => ({ health: 'healthy', visible: false }),
}))

vi.mock('@/lib/use-feature', () => ({ useFeature: () => false }))

import { StatusStrip } from './StatusStrip'

afterEach(() => {
  cleanup()
  fixture.issue = null
})

describe('StatusStrip issue reference', () => {
  it('shows the selected issue with a live stage glyph', () => {
    fixture.issue = makeIssue({
      id: asIssueId('iss_footer'),
      seq: 473,
      displayRef: 'POD-473',
      title: 'Footer issue status reference',
      stage: 'review',
    })

    const view = render(<StatusStrip />)
    expect(
      screen.getByLabelText('Review task POD-473: Footer issue status reference').dataset.issueStage,
    ).toBe('review')

    fixture.issue = { ...fixture.issue, stage: 'done' }
    view.rerender(<StatusStrip />)
    expect(
      screen.getByLabelText('Done task POD-473: Footer issue status reference').dataset.issueStage,
    ).toBe('done')
  })
})
