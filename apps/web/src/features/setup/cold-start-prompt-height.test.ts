import { describe, expect, it } from 'vitest'
import { fitColdStartPromptHeight } from './cold-start-prompt-height'

describe('fitColdStartPromptHeight', () => {
  it('rests at its minimum height while short', () => {
    expect(
      fitColdStartPromptHeight({ contentHeight: 40, minHeight: 104, windowHeight: 1000 }),
    ).toEqual({
      height: 104,
      capped: false,
    })
  })

  it('grows with the content', () => {
    expect(
      fitColdStartPromptHeight({ contentHeight: 344, minHeight: 104, windowHeight: 1000 }),
    ).toEqual({
      height: 344,
      capped: false,
    })
  })

  it('caps at 60% of the window and hands overflow to the textarea', () => {
    expect(
      fitColdStartPromptHeight({ contentHeight: 900, minHeight: 104, windowHeight: 1000 }),
    ).toEqual({
      height: 600,
      capped: true,
    })
  })

  it('never caps below its own resting height in a tiny window', () => {
    expect(
      fitColdStartPromptHeight({ contentHeight: 300, minHeight: 104, windowHeight: 120 }),
    ).toEqual({
      height: 104,
      capped: true,
    })
  })
})
