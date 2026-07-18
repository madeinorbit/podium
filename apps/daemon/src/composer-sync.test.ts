import { type ComposerDriver, claudeComposerDriver, codexComposerDriver } from '@podium/composer'
import { describe, expect, it, vi } from 'vitest'
import {
  ComposerSyncEngine,
  createHeadlessScreen,
  type ScreenReader,
  SessionComposerSync,
} from './composer-sync'

// A ScreenReader whose rendered lines are set directly by the test — lets us drive
// the engine logic without a real VT emulator.
function fakeScreen(): ScreenReader & { set(lines: string[]): void } {
  let current: string[] = []
  return {
    set: (lines) => {
      current = lines
    },
    write: () => {},
    resize: () => {},
    lines: () => current,
    flush: async () => {},
    dispose: () => {},
  }
}

describe('SessionComposerSync.scrape (read-only)', () => {
  it('publishes the extracted native draft, deduping unchanged scrapes', () => {
    const screen = fakeScreen()
    const published: { sessionId: string; text: string }[] = []
    const sync = new SessionComposerSync('s1', claudeComposerDriver, screen, (sessionId, text) =>
      published.push({ sessionId, text }),
    )

    screen.set(['╭────────────╮', '│ > hello    │', '╰────────────╯'])
    sync.scrape()
    sync.scrape() // no change → no second publish
    screen.set(['╭────────────╮', '│ > hello!   │', '╰────────────╯'])
    sync.scrape()

    expect(published).toEqual([
      { sessionId: 's1', text: 'hello' },
      { sessionId: 's1', text: 'hello!' },
    ])
  })

  it('never publishes on a null scrape (no clean composer — must not clobber)', () => {
    const screen = fakeScreen()
    const published: string[] = []
    const sync = new SessionComposerSync('s1', claudeComposerDriver, screen, (_s, t) =>
      published.push(t),
    )
    screen.set(['streaming output, no composer box'])
    sync.scrape()
    expect(published).toEqual([])
  })

  it('seed() suppresses re-publishing a known value (its own inject echo)', () => {
    const screen = fakeScreen()
    const published: string[] = []
    const sync = new SessionComposerSync('s1', claudeComposerDriver, screen, (_s, t) =>
      published.push(t),
    )
    sync.seed('hello')
    screen.set(['╭────────────╮', '│ > hello    │', '╰────────────╯'])
    sync.scrape()
    expect(published).toEqual([])
  })

  it('onData coalesces a burst of frames into one scrape', () => {
    vi.useFakeTimers()
    try {
      const screen = fakeScreen()
      const published: string[] = []
      const sync = new SessionComposerSync('s1', claudeComposerDriver, screen, (_s, t) =>
        published.push(t),
      )
      screen.set(['╭────────────╮', '│ > typing   │', '╰────────────╯'])
      sync.onData('a')
      sync.onData('b')
      sync.onData('c')
      expect(published).toEqual([]) // not yet — coalesced
      vi.advanceTimersByTime(100)
      expect(published).toEqual(['typing'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createHeadlessScreen', () => {
  it('renders fed PTY bytes into lines a claude driver can extract', async () => {
    const screen = createHeadlessScreen(40, 6)
    screen.write('╭────────────╮\r\n│ > hi there │\r\n╰────────────╯\r\n')
    await screen.flush()
    expect(claudeComposerDriver.extract(screen.lines(false))).toBe('hi there')
    screen.dispose()
  })

  it('blanks dim cells when dropDim is set (codex placeholder never scraped)', async () => {
    const screen = createHeadlessScreen(40, 4)
    // A typed line, then a DIM rotating placeholder/hint below it.
    screen.write('\x1b[0m› typed text\r\n\x1b[2mExplain this codebase\x1b[0m\r\n')
    await screen.flush()
    const dimmed = screen.lines(true)
    // The dim row is blanked → not present as text.
    expect(dimmed.join('\n')).not.toContain('Explain this codebase')
    expect(dimmed.join('\n')).toContain('typed text')
    screen.dispose()
  })
})

// A scripted terminal + fake PTY: it renders the current composer text in the
// harness's on-screen format, and APPLIES injected byte sequences the way the real
// TUI would — so a missing clear (the doubling bug) shows up as appended text.
function scriptedTerminal(driver: ComposerDriver) {
  let composer = ''
  const renderClaude = (t: string): string[] =>
    t === ''
      ? [
          'transcript',
          '╭──────────────╮',
          '│ >            │',
          '╰──────────────╯',
          '  ? for shortcuts',
        ]
      : [
          'transcript',
          '╭──────────────╮',
          ...t.split('\n').map((l, i) => (i === 0 ? `│ > ${l}   │` : `│   ${l}   │`)),
          '╰──────────────╯',
          '  ? for shortcuts',
        ]
  const renderCodex = (t: string): string[] =>
    t === ''
      ? ['transcript', '› ', '', '']
      : ['transcript', ...t.split('\n').map((l, i) => (i === 0 ? `› ${l}` : `  ${l}`)), '', '']
  const isCodex = driver === codexComposerDriver
  return {
    reader: {
      write: () => {},
      resize: () => {},
      lines: () => (isCodex ? renderCodex(composer) : renderClaude(composer)),
      flush: async () => {},
      dispose: () => {},
    } satisfies ScreenReader,
    // The fake PTY: interpret the injected bytes exactly as the harness would.
    applyBytes: (bytes: string) => {
      if (isCodex) {
        if (bytes.includes('\x03')) composer = '' // Ctrl-C wipes a non-empty codex composer
        const m = bytes.match(/\x1b\[200~([\s\S]*)\x1b\[201~/) // bracketed-paste content
        if (m) composer += m[1] // append — if NOT cleared first, the draft doubles
      } else {
        if (bytes.includes('\x15')) composer = '' // Ctrl-U cleared the composer
        composer += bytes.replace(/\x15/g, '').split('\\\r').join('\n')
      }
    },
    get composer() {
      return composer
    },
    setComposer: (t: string) => {
      composer = t
    },
  }
}

describe('SessionComposerSync injection state machine (the doubling-killer)', () => {
  // Drives the FSM: repeatedly scrape until it stabilises (writes settle into the
  // fake PTY, then verify). Two scrapes minimum satisfy the 2-frame stability gate.
  function pump(sync: SessionComposerSync, n = 6): void {
    for (let i = 0; i < n; i++) sync.scrape()
  }

  it('injects a chat target into an empty native composer, then verifies (claude)', () => {
    const term = scriptedTerminal(claudeComposerDriver)
    const published: string[] = []
    const sync = new SessionComposerSync(
      's1',
      claudeComposerDriver,
      term.reader,
      (_s, t) => published.push(t),
      { writePty: term.applyBytes },
    )
    sync.setTarget('hello from chat')
    pump(sync)
    expect(term.composer).toBe('hello from chat')
    // The injected echo is never re-published as a native edit.
    expect(published).toEqual([])
  })

  it('codex doubled-text regression: multiline, repeated flush cycles, zero duplication', () => {
    const term = scriptedTerminal(codexComposerDriver)
    const published: string[] = []
    const sync = new SessionComposerSync(
      's1',
      codexComposerDriver,
      term.reader,
      (_s, t) => published.push(t),
      { writePty: term.applyBytes },
    )
    const drafts = ['line one\nline two', 'edited one\nedited two\nedited three', 'final']
    for (const d of drafts) {
      sync.setTarget(d)
      pump(sync)
      // Each cycle lands EXACTLY the target — never the target on top of the last.
      expect(term.composer).toBe(d)
    }
    expect(published).toEqual([]) // no injected echo ever republished
  })

  it('never injects blind: no write when there is no clean composer on screen', () => {
    const term = scriptedTerminal(claudeComposerDriver)
    let writes = 0
    const sync = new SessionComposerSync('s1', claudeComposerDriver, term.reader, () => {}, {
      writePty: () => {
        writes++
      },
    })
    // No composer box on screen (streaming) → extract() is null.
    term.reader.lines = () => ['streaming output, no composer']
    sync.setTarget('should not inject')
    pump(sync)
    expect(writes).toBe(0)
  })

  it('does not inject while the native side is hot (recent input-byte tap)', () => {
    const term = scriptedTerminal(claudeComposerDriver)
    let writes = 0
    const sync = new SessionComposerSync('s1', claudeComposerDriver, term.reader, () => {}, {
      writePty: () => {
        writes++
      },
    })
    sync.setTarget('chat text')
    sync.onInputByte() // the user just typed in native → defer
    pump(sync, 2)
    expect(writes).toBe(0)
  })

  it('does not inject when native already matches the target', () => {
    const term = scriptedTerminal(claudeComposerDriver)
    term.setComposer('already here')
    let writes = 0
    const sync = new SessionComposerSync('s1', claudeComposerDriver, term.reader, () => {}, {
      writePty: () => {
        writes++
      },
    })
    sync.setTarget('already here')
    pump(sync)
    expect(writes).toBe(0)
  })

  it('does not inject while the agent is not idle (turn/overlay up — never Ctrl-C a turn)', () => {
    const term = scriptedTerminal(claudeComposerDriver)
    let writes = 0
    const sync = new SessionComposerSync('s1', claudeComposerDriver, term.reader, () => {}, {
      writePty: (bytes) => {
        writes++
        term.applyBytes(bytes)
      },
    })
    sync.setIdle(false) // agent working / a dialog is up
    sync.setTarget('chat text')
    pump(sync)
    expect(writes).toBe(0)
    // Returning to idle lets the injection proceed.
    sync.setIdle(true)
    pump(sync)
    expect(term.composer).toBe('chat text')
  })

  it('does not publish a native scrape while not idle (a transcript › is not the composer)', () => {
    const screen = fakeScreen()
    const published: string[] = []
    const sync = new SessionComposerSync('s1', codexComposerDriver, screen, (_s, t) =>
      published.push(t),
    )
    sync.setIdle(false)
    // A submitted transcript prompt is the lowest › while a turn streams.
    screen.set(['transcript', '› a submitted prompt', 'assistant reply...'])
    sync.scrape()
    expect(published).toEqual([])
  })

  it('scrapes on the idle false→true transition (draft settled during work)', () => {
    vi.useFakeTimers()
    try {
      const screen = fakeScreen()
      const published: string[] = []
      const sync = new SessionComposerSync('s1', claudeComposerDriver, screen, (_s, t) =>
        published.push(t),
      )
      sync.setIdle(false)
      // A draft sits on the composer but scrape is gated (agent working).
      screen.set(['╭────────────╮', '│ > settled while working │', '╰────────────╯'])
      sync.scrape()
      expect(published).toEqual([])
      // Back to idle: a coalesced scrape fires even though no new PTY frame arrived
      // (an idle TUI paints nothing).
      sync.setIdle(true)
      vi.advanceTimersByTime(100)
      expect(published).toEqual(['settled while working'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('self-drives a deferred injection to completion when the agent goes idle (no frames)', () => {
    vi.useFakeTimers()
    try {
      const term = scriptedTerminal(claudeComposerDriver)
      const sync = new SessionComposerSync('s1', claudeComposerDriver, term.reader, () => {}, {
        writePty: term.applyBytes,
      })
      sync.setIdle(false)
      sync.setTarget('deferred draft')
      vi.advanceTimersByTime(300) // no frames while working → nothing injects
      expect(term.composer).toBe('')
      sync.setIdle(true) // kick + self-continue drive precheck→WRITE without frames
      vi.advanceTimersByTime(300)
      expect(term.composer).toBe('deferred draft')
    } finally {
      vi.useRealTimers()
    }
  })

  it('self-demotes to read-only after repeated mismatches, republishing native truth', () => {
    const term = scriptedTerminal(claudeComposerDriver)
    // A broken PTY: injected bytes never actually change the composer, so verify
    // always mismatches. The composer keeps showing its stuck native text.
    term.setComposer('stuck native')
    const published: string[] = []
    let demoted = false
    const sync = new SessionComposerSync(
      's1',
      claudeComposerDriver,
      term.reader,
      (_s, t) => published.push(t),
      {
        writePty: () => {}, // no-op PTY → injection never takes
        onDemote: () => {
          demoted = true
        },
        maxMismatch: 2,
        verifyBudget: 1,
      },
    )
    sync.setTarget('never lands')
    pump(sync, 30)
    expect(demoted).toBe(true)
    // The scraped native truth was republished (not left silently wrong).
    expect(published).toContain('stuck native')
  })
})

describe('ComposerSyncEngine', () => {
  it('attach returns false for a harness without a composer driver', () => {
    const engine = new ComposerSyncEngine(() => {})
    expect(engine.attach('s1', 'shell', 80, 24)).toBe(false)
    expect(engine.attach('s2', 'grok', 80, 24)).toBe(false)
    expect(engine.has('s1')).toBe(false)
  })

  it('attach starts read-only sync for a claude/codex session and detach cleans up', () => {
    const engine = new ComposerSyncEngine(() => {})
    expect(engine.attach('s1', 'claude-code', 80, 24)).toBe(true)
    expect(engine.has('s1')).toBe(true)
    expect(engine.attach('s1', 'claude-code', 80, 24)).toBe(true) // idempotent
    engine.detach('s1')
    expect(engine.has('s1')).toBe(false)
  })

  it('counts native publishes in getStats() (telemetry, §7)', () => {
    vi.useFakeTimers()
    try {
      const engine = new ComposerSyncEngine(() => {}, { writePty: () => {} })
      engine.attach('s1', 'claude-code', 40, 6)
      engine.onData('s1', '╭────────────╮\r\n│ > typed │\r\n╰────────────╯\r\n')
      vi.advanceTimersByTime(100)
      const stats = engine.getStats()
      expect(stats.nativePublishes).toBeGreaterThanOrEqual(1)
      expect(typeof stats.injections).toBe('number')
      expect(typeof stats.verifyFailures).toBe('number')
      expect(typeof stats.demotions).toBe('number')
    } finally {
      vi.useRealTimers()
    }
  })

  it('feeds frames through to a native-draft publish', () => {
    vi.useFakeTimers()
    try {
      const published: { sessionId: string; text: string }[] = []
      const engine = new ComposerSyncEngine((sessionId, text) =>
        published.push({ sessionId, text }),
      )
      engine.attach('s1', 'claude-code', 40, 6)
      engine.onData('s1', '╭────────────╮\r\n│ > from native │\r\n╰────────────╯\r\n')
      vi.advanceTimersByTime(100)
      expect(published).toEqual([{ sessionId: 's1', text: 'from native' }])
    } finally {
      vi.useRealTimers()
    }
  })
})
