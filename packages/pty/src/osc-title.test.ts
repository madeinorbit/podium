import { describe, expect, it } from 'vitest'
import { createTitleScanner } from './osc-title'

const BEL = '\x07'
const ST = '\x1b\\'
const osc = (ps: number, text: string, term = BEL) => `\x1b]${ps};${text}${term}`

describe('createTitleScanner', () => {
  it('parses OSC 2 (window title) terminated by BEL', () => {
    expect(createTitleScanner().push(osc(2, 'hello-from-shell'))).toEqual(['hello-from-shell'])
  })

  it('parses OSC 0 (icon+window) terminated by ST, keeping brand glyphs', () => {
    expect(createTitleScanner().push(osc(0, '✳ rename functionality', ST))).toEqual([
      '✳ rename functionality',
    ])
  })

  it('parses OSC 1 (icon title)', () => {
    expect(createTitleScanner().push(osc(1, 'icon'))).toEqual(['icon'])
  })

  it('reassembles a title split across chunks', () => {
    const s = createTitleScanner()
    expect(s.push('\x1b]0;✳ na')).toEqual([])
    expect(s.push(`me${BEL}`)).toEqual(['✳ name'])
  })

  it('reassembles when the ESC and ] land in different chunks', () => {
    const s = createTitleScanner()
    expect(s.push('output\x1b')).toEqual([])
    expect(s.push(`]2;t${BEL}`)).toEqual(['t'])
  })

  it('keeps semicolons inside the title text (splits only on the first)', () => {
    expect(createTitleScanner().push(osc(0, 'a;b;c'))).toEqual(['a;b;c'])
  })

  it('ignores non-title OSC commands (palette, hyperlinks)', () => {
    const s = createTitleScanner()
    expect(s.push(`\x1b]4;1;rgb:00/00/00${BEL}`)).toEqual([])
    expect(s.push(`\x1b]8;;https://example.com${BEL}`)).toEqual([])
    expect(s.push(`\x1b]52;c;Zm9v${BEL}`)).toEqual([])
  })

  it('emits every frame of an animating title (spinner glyphs)', () => {
    const chunk = osc(0, '⠋ podium') + osc(0, '⠙ podium') + osc(0, '⠹ podium')
    expect(createTitleScanner().push(chunk)).toEqual(['⠋ podium', '⠙ podium', '⠹ podium'])
  })

  it('finds a title embedded between normal output', () => {
    expect(createTitleScanner().push(`before${osc(2, 'mid')}after`)).toEqual(['mid'])
  })

  it('returns an empty title verbatim (caller decides to drop it)', () => {
    expect(createTitleScanner().push(osc(2, ''))).toEqual([''])
  })

  it('drops an unterminated OSC past maxLength and recovers afterwards', () => {
    const s = createTitleScanner({ maxLength: 8 })
    expect(s.push(`\x1b]2;${'x'.repeat(100)}${BEL}`)).toEqual([])
    expect(s.push(osc(2, 'ok'))).toEqual(['ok'])
  })
})
