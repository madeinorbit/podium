import { describe, expect, it } from 'vitest'
import { fitColdStartPromptHeight } from './cold-start-prompt-height'

describe('fitColdStartPromptHeight', () => {
  it('keeps an empty prompt at its responsive resting height', () => {
    expect(
      fitColdStartPromptHeight({
        contentHeight: 240,
        empty: true,
        restingHeight: 132,
        boundsHeight: 700,
        bodyHeight: 300,
      }),
    ).toEqual({ height: 132, capped: false })
  })

  it('grows with content through all free height in the pane', () => {
    expect(
      fitColdStartPromptHeight({
        contentHeight: 420,
        empty: false,
        restingHeight: 132,
        boundsHeight: 700,
        bodyHeight: 300,
      }),
    ).toEqual({ height: 420, capped: false })
  })

  it('caps at the pane boundary and hands overflow to the textarea', () => {
    expect(
      fitColdStartPromptHeight({
        contentHeight: 900,
        empty: false,
        restingHeight: 132,
        boundsHeight: 700,
        bodyHeight: 300,
      }),
    ).toEqual({ height: 532, capped: true })
  })

  it('does not shrink below the resting height in an already-short pane', () => {
    expect(
      fitColdStartPromptHeight({
        contentHeight: 300,
        empty: false,
        restingHeight: 72,
        boundsHeight: 240,
        bodyHeight: 280,
      }),
    ).toEqual({ height: 72, capped: true })
  })
})
