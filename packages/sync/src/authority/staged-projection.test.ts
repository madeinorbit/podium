/**
 * `StagedProjection` — unit-tested against a fake span, INDEPENDENT of
 * apps/server, for the reason the rest of this role is: the kernel states the
 * ordering and the adapter owns the span it is ordered against.
 *
 * The fake is a real one, not a stub: `run` opens a span, collects the
 * registered commit applications, and runs them only when the span COMMITS.
 * A throw runs none of them, which is what makes the rollback assertions
 * measure something rather than restate the setup.
 */

import { describe, expect, it } from 'vitest'
import type { BaselineFoldPort, CommitRegistration } from './ports'
import { StagedOverlay, StagedProjection } from './staged-projection'

class FakeSpan implements BaselineFoldPort {
  /** One registry per open frame — a savepoint stack, as the real one is. */
  private frames: { step: () => void; label: string; alive: boolean }[][] = []
  private drained: { step: () => void; label: string; alive: boolean }[] = []

  spanOpen(): boolean {
    return this.frames.length > 0
  }

  onCommit(step: () => void, label: string): CommitRegistration {
    const frame = this.frames.at(-1)
    if (!frame) throw new Error(`no span open for "${label}"`)
    const entry = { step, label, alive: true }
    frame.push(entry)
    return { live: () => entry.alive }
  }

  /**
   * Run `body` inside a span; drain the applications only if it commits.
   *
   * NESTING IS THE PART THAT HAD TO BE REAL [POD-3364]. A nested frame is a
   * SAVEPOINT: its registry merges into the parent on release, still live, and
   * is DISCARDED on a throw — which is what kills the handles. The version of
   * this fake before this issue kept ONE flat list and only cleared it at depth
   * zero, so a rolled-back inner span's promotion still ran at the outer commit.
   * No test could express the enclosing-span case against it, which is a large
   * part of why the case survived.
   */
  run<T>(body: () => T): T {
    const frame: { step: () => void; label: string; alive: boolean }[] = []
    this.frames.push(frame)
    let result: T
    try {
      result = body()
    } catch (error) {
      this.frames.pop()
      for (const entry of frame) entry.alive = false
      throw error
    }
    this.frames.pop()
    const parent = this.frames.at(-1)
    if (parent) {
      // A savepoint released: the work moves up ALIVE, because whoever actually
      // commits will still run it.
      parent.push(...frame)
      return result
    }
    this.drained = frame
    for (const entry of frame) entry.step()
    return result
  }

  labels(): string[] {
    return (this.frames.at(-1) ?? this.drained).map((entry) => entry.label)
  }
}

describe('StagedProjection', () => {
  it('installs at once when no span is open', () => {
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')

    projection.install('after')

    expect(projection.read()).toBe('after')
    expect(projection.durable()).toBe('after')
  })

  it('stages inside a span and promotes on the outermost commit', () => {
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')

    span.run(() => {
      projection.install('after')
      // THE MECHANISM. The rows are not durable yet, so the committed slot must
      // still hold the old value…
      expect(projection.durable()).toBe('before')
      // …while the reader that installed it sees its own work.
      expect(projection.read()).toBe('after')
    })

    expect(projection.durable()).toBe('after')
  })

  it('drops a staged value the span rolled back, without being told', () => {
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')

    expect(() =>
      span.run(() => {
        projection.install('after')
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // No abort hook ran. The staged value is dropped on the way IN, by the next
    // read that finds no span open — which is why a CRASH between the two lines
    // could not have left it installed either.
    expect(projection.read()).toBe('before')
    expect(projection.durable()).toBe('before')
  })

  it('promotes only through a commit, even for a nested span that "succeeded"', () => {
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')

    expect(() =>
      span.run(() => {
        // The nested unit of work completes — this is the released savepoint.
        span.run(() => projection.install('after'))
        expect(projection.read()).toBe('after')
        expect(projection.durable()).toBe('before')
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    expect(projection.read()).toBe('before')
  })

  it('keeps the last of several installs in one span', () => {
    const span = new FakeSpan()
    const projection = new StagedProjection('v0', span, 'p')

    span.run(() => {
      projection.install('v1')
      projection.install('v2')
      expect(projection.read()).toBe('v2')
    })

    expect(projection.durable()).toBe('v2')
  })

  it('update() derives from what a reader would see, not from the committed value', () => {
    const span = new FakeSpan()
    const projection = new StagedProjection<string[]>([], span, 'p')

    span.run(() => {
      projection.update((current) => [...current, 'a'])
      projection.update((current) => [...current, 'b'])
    })

    // A second in-span write built on the first: the lost-update case the
    // read-through layer exists for.
    expect(projection.durable()).toEqual(['a', 'b'])
  })

  it('a promotion is immune to another commit application freshening first', () => {
    // During the drain the outermost frame is already closed, so `spanOpen()`
    // answers false. A commit application registered BEFORE this one that reads
    // the projection would freshen the staged slot away; the promotion closes
    // over its value so the order of a drain cannot lose the install.
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')
    const observed: string[] = []

    span.run(() => {
      span.onCommit(() => observed.push(projection.read()), 'a-reader-that-runs-first')
      projection.install('after')
    })

    expect(observed).toEqual(['before'])
    expect(projection.durable()).toBe('after')
  })

  it('does not shadow a read with a value a MIDDLE span rolled back', () => {
    // THE RESIDUE POD-3328 LEFT AND POD-3366 CARRIED FORWARD [POD-3364]. The
    // inner span rolls back, the OUTER span carries on and commits, and the read
    // happens in between — where `spanOpen()` still answers true, so the
    // top-level rule has nothing to say. Only the registration knows its own
    // registry was discarded.
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')
    let seenInsideTheWindow = ''

    span.run(() => {
      expect(() =>
        span.run(() => {
          projection.install('after')
          throw new Error('inner span failed')
        }),
      ).toThrow('inner span failed')

      seenInsideTheWindow = projection.read()
    })

    expect(seenInsideTheWindow).toBe('before')
    expect(projection.durable()).toBe('before')
  })

  it('still shows a read what a RELEASED nested span staged', () => {
    // THE OTHER HALF, and the reason frame identity alone is the wrong shape
    // [POD-3364]. A savepoint that RELEASES closes its frame exactly as one that
    // rolls back does — so "is the frame that staged this still live" answers
    // false here too, and a fix keyed on it would drop a value that is still
    // legitimately pending in the parent's registry. Liveness of the
    // REGISTRATION separates them: release moves it, rollback drops it.
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')
    let seenInsideTheWindow = ''

    span.run(() => {
      span.run(() => projection.install('after'))
      seenInsideTheWindow = projection.read()
    })

    expect(seenInsideTheWindow).toBe('after')
    expect(projection.durable()).toBe('after')
  })

  it('does not promote a rolled-back inner span at the outer commit', () => {
    // What the fake could not express before this issue. The inner registry is
    // DISCARDED, so its promotion is not in the batch the outer commit drains.
    const span = new FakeSpan()
    const projection = new StagedProjection('before', span, 'p')

    span.run(() => {
      expect(() =>
        span.run(() => {
          projection.install('after')
          throw new Error('inner span failed')
        }),
      ).toThrow('inner span failed')
    })

    expect(projection.durable()).toBe('before')
    expect(projection.read()).toBe('before')
  })

  it('installs immediately when no fold port is wired', () => {
    // A unit test with a pass-through `transact`, and any adapter with no
    // notion of a commit boundary.
    const projection = new StagedProjection('before', undefined, 'p')
    projection.install('after')
    expect(projection.read()).toBe('after')
    expect(projection.durable()).toBe('after')
  })
})

describe('StagedOverlay', () => {
  /** A holder: the committed store the overlay promotes into, plus the composed read. */
  function build() {
    const span = new FakeSpan()
    const committed = new Map<string, string>()
    const overlay = new StagedOverlay<string, string>(
      span,
      (key, value) => {
        if (value === undefined) committed.delete(key)
        else committed.set(key, value)
      },
      'o',
    )
    /** What a reader sees: the staged entry if there is one, else the committed row. */
    const read = (key: string) => overlay.peek(key)?.value ?? committed.get(key)
    return { span, overlay, committed, read }
  }

  it('stages inside a span and promotes on the outermost commit', () => {
    const { span, overlay, committed, read } = build()

    span.run(() => {
      overlay.set('a', 'staged')
      expect(read('a')).toBe('staged')
      expect(committed.get('a')).toBeUndefined()
    })

    expect(committed.get('a')).toBe('staged')
    expect(overlay.empty).toBe(true)
  })

  it('does not shadow a read with an entry a MIDDLE span rolled back', () => {
    // THE ISSUE, in the keyed layer [POD-3364]. `spanOpen()` still answers true
    // for the outer frame, so only the registration can report the inner
    // rollback — and it is asked, not told.
    const { span, overlay, read } = build()
    let seenInsideTheWindow: string | undefined = 'unset'

    span.run(() => {
      expect(() =>
        span.run(() => {
          overlay.set('a', 'orphaned by the inner rollback')
          throw new Error('inner span failed')
        }),
      ).toThrow('inner span failed')

      seenInsideTheWindow = read('a')
    })

    expect(seenInsideTheWindow).toBeUndefined()
  })

  it('still shows a read what a RELEASED nested span staged', () => {
    // The half that rules out keying on frame identity: a released savepoint
    // closes its frame too, and its entry is still legitimately pending.
    const { span, overlay, read } = build()
    let seenInsideTheWindow: string | undefined

    span.run(() => {
      span.run(() => overlay.set('a', 'staged by the inner span'))
      seenInsideTheWindow = read('a')
    })

    expect(seenInsideTheWindow).toBe('staged by the inner span')
  })

  it('drops an orphan read lazily from inside a LATER span (the POD-3366 hazard)', () => {
    // THE TIMING THIS USED TO PUT ON THE CALLER. `spanOpen()` answers "is ANY
    // write span open", so an orphan read from inside a later, unrelated span
    // saw `true` and survived — which is why a holder had to freshen on the way
    // IN, before opening its own span. A dead registration is dead in any span,
    // so the orphan goes without the caller having to ask first [POD-3364].
    const { span, overlay, read } = build()

    expect(() =>
      span.run(() => {
        overlay.set('a', 'orphaned by the rollback')
        throw new Error('span failed')
      }),
    ).toThrow('span failed')

    // Read lazily, from inside a NEW span, with no freshen in between.
    span.run(() => {
      expect(read('a')).toBeUndefined()
      expect(overlay.empty).toBe(true)
    })
  })

  it('drops only the dead batch and keeps a live one staged', () => {
    const { span, overlay, read } = build()

    span.run(() => {
      overlay.set('live', 'kept')
      expect(() =>
        span.run(() => {
          overlay.set('dead', 'dropped')
          throw new Error('inner span failed')
        }),
      ).toThrow('inner span failed')

      expect(read('dead')).toBeUndefined()
      expect(read('live')).toBe('kept')
      expect(overlay.empty).toBe(false)
    })

    expect([...overlay.entries()]).toEqual([])
  })

  it('moves the version when a dead entry is dropped, so a memo rebuilds', () => {
    // A holder memoises its composed view against `version` and rebuilds only
    // when it moves. Dropping the orphan without moving the version would leave
    // the memo serving the row the database threw away — the same exposure, one
    // layer up, and invisible to a test that reads the overlay directly.
    const { span, overlay } = build()
    let memoVersion = -1
    let memo: string[] = []
    const view = () => {
      if (overlay.version !== memoVersion) {
        memoVersion = overlay.version
        memo = [...overlay.entries()].map(([key]) => key)
      }
      return memo
    }

    span.run(() => {
      expect(() =>
        span.run(() => {
          overlay.set('a', 'orphaned')
          // The memo is built while the orphan is legitimately visible.
          expect(view()).toEqual(['a'])
          throw new Error('inner span failed')
        }),
      ).toThrow('inner span failed')

      // The drop must move the version, or the memo never rebuilds.
      expect(view()).toEqual([])
    })
  })

  it('promotes a batch together and never promotes a rolled-back one', () => {
    const { span, overlay, committed } = build()

    span.run(() => {
      overlay.stage([
        ['a', 'one'],
        ['b', 'two'],
      ])
      expect(() =>
        span.run(() => {
          overlay.stage([['c', 'never committed']])
          throw new Error('inner span failed')
        }),
      ).toThrow('inner span failed')
    })

    expect(committed.get('a')).toBe('one')
    expect(committed.get('b')).toBe('two')
    expect(committed.has('c')).toBe(false)
  })

  it('stages a removal distinguishably from an absent key', () => {
    const { span, overlay, committed } = build()
    committed.set('a', 'committed')

    span.run(() => {
      overlay.set('a', undefined)
      expect(overlay.peek('a')).toEqual({ value: undefined })
      expect(overlay.peek('never-touched')).toBeUndefined()
    })

    expect(committed.has('a')).toBe(false)
  })

  it('writes through immediately when no span is open', () => {
    const committed = new Map<string, string>()
    const overlay = new StagedOverlay<string, string>(undefined, (key, value) => {
      if (value === undefined) committed.delete(key)
      else committed.set(key, value)
    })

    overlay.set('a', 'immediate')

    expect(committed.get('a')).toBe('immediate')
    expect(overlay.empty).toBe(true)
  })
})
