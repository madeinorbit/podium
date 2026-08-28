import { describe, expect, it, vi } from 'vitest'
import {
  isCommandWrapperText,
  isGenericClaudeTitle,
  isTransientTitle,
  makeTitleDebouncer,
  stripSpinnerFrame,
  titleFromPrompt,
} from './title-filter'

describe('isCommandWrapperText', () => {
  it('flags the slash-command wrappers Claude writes into the transcript', () => {
    expect(isCommandWrapperText('<command-name>/model</command-name>')).toBe(true)
    expect(isCommandWrapperText('<command-message>model</command-message>')).toBe(true)
    expect(isCommandWrapperText('<local-command-stdout>Set model to Opus</local-command-stdout>')).toBe(
      true,
    )
    // The real first turn of a `/model` session: leading newline, then the wrapper.
    expect(isCommandWrapperText('\n  <command-name>/effort</command-name>\n')).toBe(true)
  })

  it('leaves a real prompt alone, including one that merely mentions a slash command', () => {
    expect(isCommandWrapperText('Fix the parser')).toBe(false)
    expect(isCommandWrapperText('why does /model not persist?')).toBe(false)
    expect(isCommandWrapperText('a < b in the comparator')).toBe(false)
  })
})

describe('isGenericClaudeTitle', () => {
  it('matches the bare placeholder, not a real title', () => {
    expect(isGenericClaudeTitle('Claude Code')).toBe(true)
    expect(isGenericClaudeTitle('  Claude Code  ')).toBe(true)
    expect(isGenericClaudeTitle('Fix the parser')).toBe(false)
  })
})

describe('titleFromPrompt', () => {
  it('takes the first non-empty line, collapsed and capped', () => {
    expect(titleFromPrompt('  \n Fix the   parser \n more')).toBe('Fix the parser')
    expect(titleFromPrompt('')).toBeUndefined()
    expect(titleFromPrompt('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('isTransientTitle', () => {
  it('flags spinner/braille and control-laden titles', () => {
    expect(isTransientTitle('⠋ thinking')).toBe(true)
    expect(isTransientTitle('\x1b[2K')).toBe(true)
    expect(isTransientTitle('   ')).toBe(true)
  })
  it('keeps a normal title', () => {
    expect(isTransientTitle('Fix the minimap bug')).toBe(false)
  })
})

describe('makeTitleDebouncer', () => {
  it('emits only the last stable title after the quiet window', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const d = makeTitleDebouncer((t) => seen.push(t), 500)
    d.push('⠋ working')
    d.push('⠙ working')
    d.push('Refactor parser')
    vi.advanceTimersByTime(500)
    expect(seen).toEqual(['Refactor parser'])
    vi.useRealTimers()
  })
})

describe('stripSpinnerFrame', () => {
  it('drops the harness spinner frame and keeps the title behind it', () => {
    // The exact payloads seen on the wire from an idle server (POD-1607).
    expect(stripSpinnerFrame('◐ Task naming and renaming in sidebar')).toBe(
      'Task naming and renaming in sidebar',
    )
    expect(stripSpinnerFrame('◓ Task naming and renaming in sidebar')).toBe(
      'Task naming and renaming in sidebar',
    )
    expect(stripSpinnerFrame('◑ Podium Safari process CPU usage')).toBe(
      'Podium Safari process CPU usage',
    )
    expect(stripSpinnerFrame('▃ building')).toBe('building')
    expect(stripSpinnerFrame('✳ rename functionality')).toBe('rename functionality')
  })

  it('leaves a title whose leading punctuation MEANS something', () => {
    expect(stripSpinnerFrame('#4 flaky spec')).toBe('#4 flaky spec')
    expect(stripSpinnerFrame('> retry the deploy')).toBe('> retry the deploy')
    expect(stripSpinnerFrame('● production incident')).toBe('● production incident')
    expect(stripSpinnerFrame('○ queued work')).toBe('○ queued work')
    expect(stripSpinnerFrame('Fix the parser')).toBe('Fix the parser')
    // Nothing behind the frame is not a title at all — isTransientTitle's job.
    expect(stripSpinnerFrame('◐')).toBe('◐')
  })

  it('keeps the list markers that are also ASCII spinner frames', () => {
    // `|/\-` and the bullets are real spinners somewhere, and also how a person
    // starts a line. Eating a word off a real title is the worse failure, and
    // the greedy quantifier would take BOTH dashes off the last one.
    expect(stripSpinnerFrame('- fix the login bug')).toBe('- fix the login bug')
    expect(stripSpinnerFrame('• deploy notes')).toBe('• deploy notes')
    expect(stripSpinnerFrame('-- watch mode')).toBe('-- watch mode')
    expect(stripSpinnerFrame('| building')).toBe('| building')
  })

  it('leaves braille alone, so the whole-title refusal still fires', () => {
    // `isTransientTitle` drops these entirely on purpose, so a harness whose
    // only title is a spinner falls through to the prompt-derived one rather
    // than being named "working".
    expect(stripSpinnerFrame('⠋ working')).toBe('⠋ working')
    expect(isTransientTitle(stripSpinnerFrame('⠋ working'))).toBe(true)
  })
})

describe('makeTitleDebouncer — the spinner storm', () => {
  it('says nothing at all while only the spinner frame turns', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const d = makeTitleDebouncer((t) => seen.push(t), 500)
    // A spinner SLOWER than the quiet window: every frame used to open a fresh
    // burst, and the unconditional leading edge re-sent the same title forever
    // — about six sessionTitleChanged a second across an idle fleet.
    for (const frame of ['◐', '◓', '◑', '◒', '◐', '◓']) {
      d.push(`${frame} Task naming and renaming in sidebar`)
      vi.advanceTimersByTime(600)
    }
    expect(seen).toEqual(['Task naming and renaming in sidebar'])
    vi.useRealTimers()
  })

  it('still ships a real rename that arrives behind a spinner', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const d = makeTitleDebouncer((t) => seen.push(t), 500)
    d.push('◐ Task naming')
    vi.advanceTimersByTime(600)
    d.push('◓ Task naming')
    vi.advanceTimersByTime(600)
    d.push('◑ Rename the sidebar rows')
    vi.advanceTimersByTime(600)
    expect(seen).toEqual(['Task naming', 'Rename the sidebar rows'])
    vi.useRealTimers()
  })
})
