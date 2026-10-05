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
owning model. `requiresReaction` enables MobX's public development assertion
for callers whose untracked reads are mistakes. The one private MobX tracking
check lives inside `keyedComputed`; callers must use public MobX APIs.

```ts
import { keyedComputed } from '@podium/mobx-helpers'

const title = keyedComputed('issue.title', (id: string) => issues.get(id)?.title)
```

`DeadlineClock` and `nextUp` are the existing deadline clock, moved unchanged
from client-graph. Demand helpers and a tracked `now` will follow in POD-5424.
Diagnostic `debugName`/`enableDebugNames` move with the clock and preserve its
existing names and production switch. Run `bun run lint:mobx-private` to
refuse private MobX imports, namespace calls and deep imports elsewhere.
