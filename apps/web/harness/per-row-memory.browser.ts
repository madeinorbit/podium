/** Reuse POD-5133's real runtime/replica/legacy sidebar fixture unchanged.
 * Collector slot `legacy` means hand here; slot `pool` means lean. Both use
 * the same switch-OFF product runtime, then add the same 20-row prototype window.
 * The original product fixture/build is also captured separately as the control. */
import type { ClientRuntime } from '@podium/client-core/engine'
import { createEngineLocals } from '@podium/client-graph/shared/engine-locals'
import { createRowSource, type RowSourceReplica } from '@podium/client-graph/shared/row-source'
import { HandPool } from '../../../packages/worklist-proto/arms/hand/pool/pool'
import { LeanPool } from '../../../packages/worklist-proto/arms/lean/src/pool'
import {
  handWindow,
  leanWindow,
  mountWindow,
  WINDOW_ROWS,
} from '../../../packages/worklist-proto/arms/lean/src/window'

const requested = new URLSearchParams(location.search).get('mobxSidebar') === '1' ? 'lean' : 'hand'
const originalUrl = new URL(location.href)
const legacyUrl = new URL(location.href)
legacyUrl.searchParams.set('mobxSidebar', '0')
history.replaceState(null, '', legacyUrl)
await import('../test/pool-memory.browser')
const memory = window.__memory
while (!memory.ready()) await new Promise((done) => setTimeout(done, 25))
history.replaceState(null, '', originalUrl)
const originalState = memory.state.bind(memory)
const originalOwners = memory.owners.bind(memory)
const owners = originalOwners()
const runtime = owners.runtime as ClientRuntime
const feed = createRowSource(runtime, owners.replica as unknown as RowSourceReplica, {
  mode: 'overlaid',
})
const locals = createEngineLocals(runtime)
// Same constructor, seed and subscriptions as handPoolArm.create, without its
// unused web/native list imports. Both arms mount the common window below.
const hand =
  requested === 'hand'
    ? new HandPool(undefined, locals.source.get(), undefined, {
        load: feed.source.row!.bind(feed.source),
      })
    : null
if (hand) {
  hand.apply({
    type: 'replace',
    rows: [
      ...feed.source.snapshot('session'),
      ...feed.source.snapshot('issue'),
      ...feed.source.snapshot('worktree'),
    ],
  })
  feed.source.subscribe((event) => hand.apply(event))
  locals.source.subscribe((changed) => hand.applyLocals(locals.source.get(), changed))
}
const pool = hand ?? new LeanPool(feed.source, locals.source)
const windowPool = hand ? handWindow(hand) : leanWindow(pool as LeanPool)
const element = document.createElement('section')
element.dataset.prototypeWindow = requested
element.style.cssText = 'width:300px;height:600px;overflow:auto;font:12px monospace'
document.body.append(element)
mountWindow(windowPool, element)
while (element.querySelectorAll('[data-prototype-row]').length !== WINDOW_ROWS)
  await new Promise((done) => setTimeout(done, 25))
while (pool.residency?.hasQueued()) await new Promise((done) => setTimeout(done, 60))

class Pod5133OwnerHolder {}
function fields(prefix: string, value: object, into: Record<string, object>) {
  into[prefix] = value
  for (const [key, field] of Object.entries(value))
    if (field && typeof field === 'object') into[`${prefix}.${key}`] = field
}
Object.assign(memory, {
  mode: () => (requested === 'hand' ? 'legacy' : 'pool'),
  state: () => ({
    ...originalState(),
    prototype: requested,
    windowRows: element.querySelectorAll('[data-prototype-row]').length,
    rows: Object.fromEntries(
      Object.entries(pool.tables).map(([kind, table]) => [kind, table.size]),
    ),
    visible: windowPool.order().length,
    mountedComputeds: requested === 'lean' ? (pool as LeanPool).mounted.size : null,
    cold: { issue: pool.residency?.size('issue'), session: pool.residency?.size('session') },
  }),
  owners: () => {
    const into = originalOwners()
    fields('pool', pool, into)
    fields('prototype.feed', feed, into)
    fields('prototype.locals', locals, into)
    return into
  },
  holdOwners: () =>
    Object.assign(window, {
      __pod5133Owners: Object.assign(new Pod5133OwnerHolder(), memory.owners()),
    }),
})
