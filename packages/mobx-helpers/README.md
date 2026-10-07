# @podium/mobx-helpers

One home for Podium's shared MobX helpers. These mirror
[mobx-utils](https://github.com/mobxjs/mobx-utils): `mobx-utils` 6.1.1 only
supports MobX 6; MobX 7 support is the open PR
[mobxjs/mobx-utils#340](https://github.com/mobxjs/mobx-utils/pull/340).
When mobx-utils supports MobX 7, consider replacing these helpers with it.

`keyedComputed(name, fn, options?)` follows `computedFn`: one memoised computed
per argument key, shared while observed and released when its last observer
leaves. An untracked read computes directly and creates no cache entry. Keys
use identity; extra arguments must describe the same computation for the same
key. `clear()` drops the registry, including during owner disposal.
`keys()` and `size` expose the current observed registry for diagnostics.

Result comparison defaults to `compareDefault` (identity, MobX 7’s name for `comparer.default`), never structural.
Pass `equals` explicitly only where the caller needs a different comparison.
Names may be lazy, and an optional `context` attributes a computed to its
owning model. With MobX's `computedRequiresReaction` enabled, `requiresReaction`
opts into the development tracked-context warning
for callers whose untracked reads are mistakes. The one private MobX tracking
read lives inside `keyedComputed`; it checks tracking and batch state without a
temporary computed. Callers must use public MobX APIs.

```ts
import { keyedComputed } from '@podium/mobx-helpers'

const title = keyedComputed('issue.title', (id: string) => issues.get(id)?.title)
```

`createDemandAtoms(name, options?)` retains one atom per observed key. Its
`observe(key)` reports the read; `onObserved` and `onUnobserved` own demand
acquisition and release. Imperative probes allocate nothing and cannot release
another reader. `borrowAtom` lends an existing owner atom without a duplicate;
its release listener detaches on `clear()`. One shared public admission atom
preserves the zero-allocation cold-probe boundary.

`DeadlineClock` and `nextUp` are the existing deadline clock, moved unchanged
from client-graph. A tracked `now` will follow in POD-5424.
Diagnostic `debugName`/`enableDebugNames` move with the clock and preserve its
existing names and production switch. Run `bun run lint:mobx-private` to
refuse private MobX imports, namespace calls and deep imports elsewhere.

`draft(source, { fields, save })` follows mobx-utils `createViewModel` for a
form that edits an existing record: `d[field]` reads the local value once
edited, else the source's live value, so untouched fields keep following the
source; setting a field back to the source's value un-dirties it. `d.model`,
`d.isDirty`, `d.isPropertyDirty(key)`, `d.changedValues`, `d.reset()` and
`d.resetProperty(key)` keep `createViewModel`'s names. `d.submit()` calls `save`
ONCE with only the changed values, then clears them (a save that throws keeps
them). The source is only read: a plain object or a class with getter fields
works without becoming a MobX observable object. The local values are
observable and every write is an action. For an issue, `draftOf(issue)`
(`@podium/client-graph/write/draft-of`, loaded with the form's screen) saves
through `issue.update(changes)`: one edit transaction.

```ts
const d = draftOf(issue)
d.title = 'Fix login page'
d.stage = 'review'
d.submit() // one issues.update { title, stage }
```
