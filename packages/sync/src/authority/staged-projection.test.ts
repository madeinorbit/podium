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
import type { BaselineFoldPort } from './ports'
import { StagedProjection } from './staged-projection'

class FakeSpan implements BaselineFoldPort {
  private depth = 0
  private registered: { step: () => void; label: string }[] = []

  spanOpen(): boolean {
    return this.depth > 0
  }

  onCommit(step: () => void, label: string): void {
    if (this.depth === 0) throw new Error(`no span open for "${label}"`)
    this.registered.push({ step, label })
  }

  /** Run `body` inside a span; drain the applications only if it commits. */
  run<T>(body: () => T): T {
    this.depth++
    let result: T
    try {
      result = body()
    } catch (error) {
      this.depth--
      // A rollback: the registered work is DISCARDED, never reported.
      if (this.depth === 0) this.registered = []
      throw error
    }
    this.depth--
    if (this.depth === 0) {
      const batch = this.registered
      this.registered = []
      for (const entry of batch) entry.step()
    }
    return result
  }

  labels(): string[] {
    return this.registered.map((entry) => entry.label)
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

  it('installs immediately when no fold port is wired', () => {
    // A unit test with a pass-through `transact`, and any adapter with no
    // notion of a commit boundary.
    const projection = new StagedProjection('before', undefined, 'p')
    projection.install('after')
    expect(projection.read()).toBe('after')
    expect(projection.durable()).toBe('after')
  })
})
