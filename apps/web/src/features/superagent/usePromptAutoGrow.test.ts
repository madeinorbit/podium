import { describe, expect, it } from 'vitest'
import { fitPromptHeight } from './usePromptAutoGrow'

/**
 * The prompt box's height decision (POD-516). happy-dom has no layout engine —
 * scrollHeight is always 0 there — so the arithmetic is a pure function and it
 * is tested here, with measurements a real 13px/18px composer produces.
 *
 * lineHeight 18 + padding 6 = a 24px line, which is the resting box.
 */
const LINE = 18
const PAD = 6
const ONE = LINE + PAD

const fit = (over: Partial<Parameters<typeof fitPromptHeight>[0]>) =>
  fitPromptHeight({
    content: 0,
    empty: false,
    lineHeight: LINE,
    padding: PAD,
    maxLines: 8,
    paneHeight: 0,
    ...over,
  })

describe('fitPromptHeight', () => {
  const cases: Array<{
    name: string
    input: Partial<Parameters<typeof fitPromptHeight>[0]>
    height: number
    capped: boolean
  }> = [
    // An empty field's scrollHeight includes the placeholder, which wraps to two
    // lines in a narrow dock. Sizing to it left the resting box a line too tall.
    {
      name: 'ignores a wrapped placeholder and rests at one line',
      input: { empty: true, content: ONE + LINE },
      height: ONE,
      capped: false,
    },
    {
      name: 'the first keystroke does not move it — one line is one line',
      input: { content: ONE },
      height: ONE,
      capped: false,
    },
    {
      name: 'grows a line at a time as the prompt wraps',
      input: { content: ONE + LINE * 2 },
      height: ONE + LINE * 2,
      capped: false,
    },
    {
      name: 'caps at maxLines and reports it, so the field starts scrolling',
      input: { content: ONE + LINE * 40 },
      height: LINE * 8 + PAD,
      capped: true,
    },
    {
      name: 'a short pane caps it before maxLines does',
      input: { content: ONE + LINE * 40, paneHeight: 200 },
      height: 200 * 0.42,
      capped: true,
    },
    {
      name: 'a tall pane leaves the line cap in charge',
      input: { content: ONE + LINE * 40, paneHeight: 900 },
      height: LINE * 8 + PAD,
      capped: true,
    },
    // A dock dragged down to nothing must still show the caret: one line wins
    // over the room share, and the field scrolls inside it.
    {
      name: 'never goes below one line, however little room there is',
      input: { content: ONE + LINE * 3, paneHeight: 30 },
      height: ONE,
      capped: true,
    },
    {
      name: 'shrinks back to one line when the draft is cleared',
      input: { empty: true, content: 0 },
      height: ONE,
      capped: false,
    },
    // A measurement that undershoots one line (a font that has not loaded yet)
    // must not collapse the box.
    {
      name: 'floors a short measurement at one line',
      input: { content: 4 },
      height: ONE,
      capped: false,
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const out = fit(c.input)
      expect(out.height).toBe(c.height)
      expect(out.capped).toBe(c.capped)
    })
  }
})
