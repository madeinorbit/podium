/**
 * THE RUNNING-OBJECT HALF of the scoped-feed audit (POD-1077).
 *
 * ---------------------------------------------------------------------------
 * WHY THE AUDIT IS TWO INSTRUMENTS AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * `scripts/audit-scoped-feed.ts` resolves no modules: it reads source text, so it
 * runs in a fresh checkout and in a worktree with no local `@podium` install. That
 * is a real capability and a real blind spot. POD-732's line is the standard —
 * *"an empty router satisfies every absence claim perfectly"* — and its scoped-feed
 * form is worse: a publisher that delivered NOTHING to ANYONE would satisfy every
 * text check in that file, and would look like maximal privacy.
 *
 * So the same `runtimeChecks` are run here, against the real `Authority` and the
 * real `FeedPublisher`, under vitest where the workspace resolves.
 *
 * ---------------------------------------------------------------------------
 * AND THIS FILE PROVES THE CHECKS CAN SAY YES
 * ---------------------------------------------------------------------------
 *
 * A green `runtimeChecks()` is an absence claim, so it is worth exactly as much as
 * the instrument's ability to report a presence. `runtimeChecks` therefore takes
 * the kernel classes as an ARGUMENT, and the cases below hand it three
 * deliberately-broken kernels — one that does not filter, one that filters without
 * watermarking (the protocol break POD-351 named), one whose watermarks demote —
 * and assert that each is CAUGHT. These are the planted fixtures `--probe` gives
 * the text checks.
 */

import { describe, expect, it } from 'vitest'
import { runtimeChecks, shippedKernel, type KernelUnderTest } from './audit-scoped-feed'
import { Authority } from '../packages/sync/src/authority/authority'
import { FeedPublisher } from '../packages/sync/src/feed'

describe('the shipped kernel passes its own runtime audit', () => {
  it('filters, watermarks, and survives a suppressed firehose', async () => {
    expect(await runtimeChecks(await shippedKernel())).toEqual([])
  })
})

describe('the instrument can say YES — three broken kernels, three catches', () => {
  const broken = async (patch: (kernel: KernelUnderTest) => KernelUnderTest) =>
    runtimeChecks(patch(await shippedKernel()))

  it('catches a feed that does NOT filter', async () => {
    // Every principal is delivered every row: `subscribe` ignores the principal it
    // was given and hands the batch to the subscriber untouched.
    const findings = await broken((kernel) => ({
      ...kernel,
      Authority: class extends (Authority as never as new (deps: never) => Authority) {
        subscribe(_principal: never, subscriber: never): () => void {
          return super.subscribe({ kind: 'user', userId: 'ada' }, subscriber)
        }
      } as never as KernelUnderTest['Authority'],
    }))
    expect(findings.map((f) => f.check)).toContain('runtime-filter')
  })

  it('catches a feed that filters WITHOUT watermarking — the protocol break', async () => {
    // The dangerous one. Suppressed rows simply vanish: no frame, no certified
    // range, nothing for the replica to advance on. Every "she did not see it"
    // assertion passes and the client never converges.
    const findings = await broken((kernel) => ({
      ...kernel,
      Authority: class extends (Authority as never as new (deps: never) => Authority) {
        subscribe(principal: never, subscriber: (d: never) => void): () => void {
          return super.subscribe(principal, ((delivery: { kind: string; changes: unknown[] }) => {
            if (delivery.kind === 'batch' && delivery.changes.length === 0) return
            subscriber(delivery as never)
          }) as never)
        }
      } as never as KernelUnderTest['Authority'],
    }))
    expect(findings.map((f) => f.check)).toContain('runtime-watermark')
  })

  it('catches watermarks that DEMOTE the connection (D13.4)', async () => {
    // A publisher that puts watermarks through the bounded queue: a suppressed
    // firehose then forces a re-bootstrap for activity the principal may not even
    // observe.
    const findings = await broken((kernel) => ({
      ...kernel,
      FeedPublisher: class extends (FeedPublisher as never as new (deps: never) => FeedPublisher) {
        publish(principal: never, delivery: never): void {
          const d = delivery as { kind: string; throughSeq: number; changes: readonly unknown[] }
          if (d.kind === 'batch' && d.changes.length === 0) {
            // The regression: pad the "empty" frame so it consumes queue budget.
            super.publish(principal, {
              ...d,
              changes: [
                { seq: d.throughSeq, entity: 'session', entityId: 'pad', op: 'upsert', value: {} },
              ],
            } as never)
            return
          }
          super.publish(principal, delivery)
        }
      } as never as KernelUnderTest['FeedPublisher'],
    }))
    expect(findings.map((f) => f.check)).toContain('runtime-watermark')
  })
})
