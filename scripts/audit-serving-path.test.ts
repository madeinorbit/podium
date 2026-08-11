/**
 * THE RUNNING-OBJECT HALF of the one-serving-path gate (POD-1203).
 *
 * `audit-serving-path.ts` reads source text and resolves no modules, so it can
 * say "nothing constructs a full list" — a claim no runtime check can make,
 * because a module that is never loaded looks exactly like one that does not
 * exist. This file is the other half and it can make the claims text cannot: the
 * SHIPPED objects really do have one tail, the two deleted methods really are
 * absent from the real prototypes, and a real edge over a real Authority really
 * does serve a v1 peer from the feed alone.
 *
 * Neither half is sufficient. A source-text gate passes against a tree where the
 * modules were deleted; a runtime gate passes against a tree with a second path
 * in a file nothing imported yet.
 */

import { describe, expect, it } from 'vitest'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { WriteFunnel } from '../apps/server/src/modules/funnel'
import { SessionLifecycle } from '../apps/server/src/modules/sessions/lifecycle'
import { feedTestPlumbing } from '../apps/server/src/gateway/feed-test-plumbing'
import { outcomesOf, PROBES, runChecks } from './audit-serving-path'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

describe('the shipped objects have one serving tail', () => {
  it('neither deleted method exists on the real prototypes', () => {
    // PROTOTYPE SHAPE, not source text. A method re-added under either name is
    // caught here even if it is written in a way the text scanner does not match
    // (assigned, mixed in, defined via `Object.defineProperty`).
    expect(WriteFunnel.prototype).not.toHaveProperty('publishComputed')
    expect(SessionLifecycle.prototype).not.toHaveProperty('fanOutSnapshot')
    // …and the delta half, which moved rather than vanished: a `sendMetadataDelta`
    // still on this object would mean the framing question is answered in two
    // places.
    expect(SessionLifecycle.prototype).not.toHaveProperty('sendMetadataDelta')
  })

  it('a REAL edge serves a v1 peer from the feed, with no list builder in reach', () => {
    const plumbing = feedTestPlumbing()
    plumbing.ledger.commit({
      write: () => {},
      changes: () => [{ entity: 'issue', id: 'i1', op: 'upsert', value: { id: 'i1' } }],
    })
    const received: { type: string }[] = []
    const refusal = plumbing.serving.attach(
      {
        id: 'peer',
        wireVersion: 1,
        acceptsDelta: false,
        send: (message) => received.push(message),
      },
      DEVICE_GRADE_PRINCIPAL,
      plumbing.routingPrincipal('peer'),
    )
    expect(refusal).toBeNull()
    // The ONLY input was a ledger commit. There is no feature, no publisher and
    // no list builder in this object graph, so an `issuesChanged` here can only
    // have been folded out of the feed.
    expect(received.map((m) => m.type)).toContain('issuesChanged')
  })
})

describe('the gate can say YES', () => {
  it('every planted violation produces its OWN check', () => {
    for (const probe of PROBES) {
      expect(outcomesOf(probe.input), probe.name).toContain(probe.expect)
    }
  })

  it('and the real tree is spared', () => {
    // The half that stops "every probe fires" from being satisfied by a gate
    // that reports everything.
    expect(
      runChecks({
        read: (path) => {
          try {
            return readFileSync(join(ROOT, path), 'utf8')
          } catch {
            return null
          }
        },
        sources: () =>
          new TextDecoder()
            .decode(
              Bun.spawnSync(['git', 'ls-files', '--', 'apps/**/*.ts', 'packages/**/*.ts'], {
                cwd: ROOT,
              }).stdout,
            )
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
      }),
    ).toEqual([])
  })
})
