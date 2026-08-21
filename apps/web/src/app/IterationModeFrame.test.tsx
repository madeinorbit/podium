import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { IterationModeFrame, ITERATION_TITLE_PREFIX, iterationTitle } from './IterationModeFrame'

afterEach(cleanup)

describe('IterationModeFrame', () => {
  it('renders nothing in an installed build — the define is absent there', () => {
    render(<IterationModeFrame active={undefined} />)
    expect(screen.queryByTestId('iteration-mode-frame')).toBeNull()
  })

  it('renders nothing when the flag is present but false', () => {
    render(<IterationModeFrame active={false} />)
    expect(screen.queryByTestId('iteration-mode-frame')).toBeNull()
  })

  it('says ITERATION MODE where nobody can miss it', () => {
    render(<IterationModeFrame active={true} />)
    expect(screen.getByTestId('iteration-mode-frame')).toBeTruthy()
    expect(screen.getByText(/iteration mode/i)).toBeTruthy()
  })

  it('never eats a click meant for the app it is framing', () => {
    render(<IterationModeFrame active={true} />)
    // Both the frame and the label it carries: either one swallowing a click
    // would make the mode change how the app behaves, not just how it looks.
    const frame = screen.getByTestId('iteration-mode-frame') as HTMLElement
    expect(frame.style.pointerEvents).toBe('none')
    expect((screen.getByText(/iteration mode/i) as HTMLElement).style.pointerEvents).toBe('none')
  })

  it('reserves no layout space — the frame is what ships, minus the paint', () => {
    render(<IterationModeFrame active={true} />)
    const frame = screen.getByTestId('iteration-mode-frame') as HTMLElement
    expect(frame.style.position).toBe('fixed')
  })

  it('marks the tab too, so a background window is identifiable', () => {
    expect(iterationTitle('Podium', true)).toBe(`${ITERATION_TITLE_PREFIX}Podium`)
    expect(iterationTitle('Podium', false)).toBe('Podium')
    // Idempotent: React re-renders, and the title must not grow a prefix each time.
    expect(iterationTitle(`${ITERATION_TITLE_PREFIX}Podium`, true)).toBe(
      `${ITERATION_TITLE_PREFIX}Podium`,
    )
  })
})
