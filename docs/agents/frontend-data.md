# Frontend data

How client code (web, desktop, phone) holds, derives and shows data. The data layer is the MobX pool in `packages/client-graph`; helpers come from `@podium/mobx-helpers`. Every frontend change follows this guide. Some homes named here are still being built: the shared clock (POD-5863), the UiStore (POD-5797) and the LiveStore (POD-5798). Until one lands, leave that state where it is today, and add no new code in the old pattern.

## Where things live

| What | Home |
|---|---|
| Facts about a server record | its **shared model**, `pool.model(entity, id)` (`models.ts`). Stored fields: one line in `shared/schema.ts` citing the zod type in `@podium/model`; the record type itself (its parts, links and collections) is declared once in `@podium/model` `records/declarations.ts`, and the schema reads its collections and link keys from there. Derived fields: `@lazy` getters. |
| A rule of one view about a record | that view's **companion** (`WorklistIssue` wraps an `IssueModel`), made by `companion()` on the view model |
| A view's UI state (tab, folds, selection, form input) | the **view model**, or the one component that uses it |
| App-wide screen state saved on this device (open view, panes, tabs, focus) | the **UiStore** |
| Live server values that are not records (connection, quota, usage; a record's busy, last input, context use and terminal size) | the **LiveStore**: pushed by the server, never saved, each value replaces the old. A record's live parts are declared in `@podium/model` `records/declarations.ts` as `liveReadings: { topic: payloadSchema }`. Their fields and protocol payloads share that schema; the LiveStore creates their maps and demand hooks generically. A live value is a `@lazy` field on its model that reads the LiveStore (`session.busy`, `session.geometry`); a stored row never carries it. |
| A one-off server answer (search hits, file tree, git diff, receipt) | the view model that asked (a **request answer**), with loading and error fields; dropped when the view closes |
| Machinery: connection, outbox, a conversation's transcript window, streaming and send queue | a **service**. It owns its reactions; screens never read it. |
| A form's unsaved changes to an existing record | an **edit draft** (How to) |
| Chat text being typed to an agent (message draft) | a stored field of the session, synced to other devices; never an edit draft |

A **view** is a feature the user sees: the worklist, mission, issue detail, launcher, settings. Several screens can draw one view (the desktop sidebar and the phone Work tab both draw the worklist). They share its view model and companions and differ only in components. The root component creates the view model, or gets it from the app, and passes it down through React context.

## Rules

1. **One shared model per record.** A record is anything the server sends that has an ID, can change while the user looks, and is shown in more than one place, whether it arrives through sync or through a request. A request puts the records it returns into the pool; the view keeps their IDs.
   - Never build a second object holding facts about a record, and never re-derive in a view what its model answers.
   - Never write a derived value into a stored row.
   - A live value of a record (a machine's load) is a field on that record's model.
   - Group a model's fields by topic under heading comments.
2. **Derived values are `@lazy` getters.**
   - A field is created on first read and dropped when nothing watches it.
   - Outside components (handlers, loops), a read is remembered for the current action or synchronous run, so read fields directly instead of copying them into locals.
   - Use `@lazy({ equals })` only for a small object rebuilt each run, or for a list (rule 5).
   - No `computedFn`, `keepAlive` or hand-made caches.
3. **Components get models, read late and stay small.**
   - Pass a model, a companion or an ID.
   - Each small `observer` reads only the fields it shows, under the field's own name. No adapter objects or Proxies that rename fields.
   - Never pass a bundle of copied values through props or context. Rebuilt in a derived field, it redraws every reader on any change; copied once (in a constructor, React state or a ref), it goes stale.
4. **Store each piece of state once.**
   - Keep one `selectedId`; each row derives `selected` from it.
   - A value that follows from other state (the selected record is gone, from `exitKind`) is a derived field, never a second field kept in step by a reaction.
   - A view's rules live in its companion, shared by every screen that draws the view. Create a companion only when a view has per-record rules; otherwise pass the bare model.
   - Model or companion? Ask: *would the answer change if this view worked differently?* Yes means companion.
5. **One field, one question, the narrowest answer.**
   - A `@lazy` field answers one question. Bundle parts only if every reader needs all of them and they always change together. Prefer an ID, number or boolean over an object.
   - Lists: pass on the data layer's own list (relation, declared subset, query result), or build one as `@lazy({ equals: compareShallow })`. Lists hold models, or IDs for records that may not be loaded. Never write "compare with my previous result" code.
   - A count over many records shown all the time: a declared subset's size when its rule reads only each record's own fields; otherwise one `@lazy` fact per record plus a `@lazy` total (up to about 10,000 records).
6. **Live by default.** The exceptions, each declared where the value is defined, are edit drafts (How to) and:
   - **On request**: an expensive or server-side answer is loaded by a view-model action when the user asks. Nothing runs before or after.
   - **Stored on open**: a value that must not move under the user, or that is expensive while its data churns, is stored by the view model's `open()` and taken again on the next open. Never on shared models.
7. **Work over the working set.**
   - Live lists and counts cover open records, recently closed ones and what a view shows; questions over all history are on request.
   - Read rows through models or `MobxPool.row`. The device keeps two layers (POD-7157): local storage holds everything fetched and keeps it current, and memory holds the policy collections, the stubs, what views are reading (held) and a warm set of recently left screens, shrunk only when idle. Indexes cover only rows in memory (the device index, `shared/device-index.ts`); none is sized by history. A row not in memory is described by its stub (`pool.stub`, issues only) or answers `LOADING` and loads, from local storage when the device has it and from the server otherwise. A row that left memory but not the device is never REMOVED. Reading a collection through the pool holds it for as long as it is observed; view code never calls the loader directly.
   - Looking up a record gives one of three answers, and every caller handles all three: **here**; **on its way** (`LOADING`, and a batched load starts); or **gone** (deleted, or not visible to this user, with the reason).
8. **One way to write state**, in every class (models, companions, view models, stores, services):
   ```ts
   @observable accessor tab = 'chat'                // a value
   @observableRef accessor layout: Layout = {}      // replaced whole, never changed inside
   readonly folded = observable.set<string>()       // a collection whose contents change
   @action fold(id: string) { this.folded.add(id) } // a change
   @lazy get visibleCount() { … }                   // derived
   ```
   App code uses no `observable.box`, `makeObservable` or `makeAutoObservable`. `createAtom` and `new Reaction` appear only in the data layer and `@podium/mobx-helpers`.
9. **Lifetimes.**
   - The only "ID → object" maps allowed are: the pool's models, `companion()` maps, the view registry (`pool.sources.view`), the data layer's indexes and the LiveStore's readings (frozen values replaced whole, never objects with fields of their own).
   - A view that opens and closes gets a new view model per opening. Its root component creates it, and closing drops it together with its companions. Anything that must survive a reopen goes into the UiStore, on purpose.
   - Always-on views (the worklist) keep one view model.
   - **Side state** (POD-7454). In `packages/client-graph` and `packages/sync/src/replica`, a Map or Set kept past one call (a class field, a constructor field, a module value) is a `SideMap`/`SideSet` from `@podium/sync/side-state`, or carries `// side-state: <identity|signal|declaration|snapshot|scratch>: <reason>` on the line above (`bun run lint:untracked-reads`). A derivation that reads one fails its test (development builds warn): nothing re-runs it when the collection changes. Read a tracked value instead. Where a signal the reader observes already carries the change, wrap the read in `signalledRead` and tag it like an `untracked` read in `clock.ts`.
10. **Time.**
    - The current time comes from the shared clock, which ticks only while something watches it, at the reader's precision (seconds under an hour, minutes above). Only small label and timer components read it. No `Date.now()` in derived fields, and no intervals in components.
    - A change due at a known moment (a record leaving a list, evidence expiring, a snooze ending) is a deadline: one timer for the next due one, re-checked when the app wakes, becomes visible or regains focus.
    - Polling runs only while its view is visible; a server push replaces it wherever possible.
    - Request answers never poll: the owning view model declares its topic signal or related pool change, or a focus/visibility fallback when no trigger exists. It unsubscribes and drops the answer on close. Source sampling belongs to a demand-bound topic producer (ADR 7 Amendment 2).

## Fields backed by on-demand records

Holding follows reading for model relations too: **the read is the request**. A field
backed by a separate on-demand record returns its value or `LOADING`, never an empty
value in place of data that has not arrived. The observed read holds its collection
and uses the loader's batch window; closing the view releases the hold. A previously
complete answer stays readable while refreshing, and an offline first read shows
"not available offline" through `pool.collections.reading`.

Read the model field or relation getter and handle `LOADING` explicitly. Editors
must not open from an unloaded value, and commands must refuse to save over it.
Lists must not read body fields per row: that requests a separate body instance for
every issue. Development builds warn when one view holds more than 20 body instances,
and warn about raw graph or link reads that bypass holding relation getters.

Test these reads with the [empty-device harness](#testing-a-screen-on-an-empty-device),
including content assertions after loading; full-device fixtures cannot prove the
request happened. The phone follows in its own phase, after the new phone design
(POD-7554 / POD-7555).

## How to

- **Look up one record:** `pool.model(entity, id)` and `pool.row(entity, id)` return `Lookup<T>`: the model/row, `LOADING`, or `Gone`. Import `LOADING` and `isGone` from `@podium/client-graph` and handle each answer:
  ```ts
  const issue = pool.model('issue', id)
  if (issue === LOADING) return renderLoading()
  if (isGone(issue)) return renderGone(issue.reason)
  return renderIssue(issue)
  ```
  A record the device does not hold whole goes to the one loader (`@podium/sync` `CollectionLoader`, read through `pool.collections`): it asks the server for the record's "one record" instance in a 50 ms batch, duplicates removed, a visible view's requests first, and answers `LOADING`; once the server answered without it, `Gone` (`not-visible`). A row the device holds but the pool has not placed is placed in the same kind of window, with no fetch. Without a connection nothing starts: a view reads `pool.collections.reading(answer)` and shows "not available offline" for `offline`, never an endless loading row. A reader of an issue's reference, state or parent reads `pool.stub(id)`: a stub is here, so it never fetches. Counts over all history (`pool.collections.countBy`, `childCounts`, `treeProgress`) read the stubs and answer `LOADING` until the stub collection, or the tree's own instance, is complete. Holding follows reading: a view reads a collection through the pool (`held`, `pageEnded`, `pageTotal`, `treeHeld`, or a lookup), and that read holds the instance for as long as anything observes it; once nothing does, it is cache. There is nothing to release and no view-facing `request` or `show`: a test fails on any loader call outside the device store (`view-loader-calls.test.ts`). A record a view looked up stays held while it is read. Records a request returns (search hits) are held by reading their ids through `pool.collections.holdRecords(entity, ids)`; the view keeps the ids. `pool.collections.nextPage(instance)` asks for the next page of an instance a view reads. A command on a record the device does not hold paints nothing; its result arrives through the feed. A replica `removed` exit returns `Gone` with reason `removed` immediately, even while its removal publication is pending. An unsuccessful load settles as `Gone` with reason `not-visible`; another read never restarts it until the feed changes that ID or replaces the scope. A resident row carrying soft-delete metadata is still a row, so restore flows can read it. `EntityModel.row` preserves the same three answers.
  A nullable list/view can deliberately omit gone records with `omitGone(answer)`; it must still handle `LOADING`. Optional resident details/counts can use `here(answer)` to omit pending and gone records. Both helpers live in `@podium/client-graph/lookup` and document the caller's omission policy. Maintenance modes (`mark`, `peek`) do not start a load.
  Startup boundary: `lookup.ts` is part of the always-pool store contract and its first-screen readers. It imports only `loading.ts` and defines scalar sentinels and narrowing policies; it brings in no optional screen.
- **Per-record rules for one view, with selection and a list:**
  ```ts
  class WorklistIssue {
    constructor(readonly issue: IssueModel, private readonly worklist: Worklist) {}
    @lazy get selected() { return this.worklist.selectedId === this.issue.id }
    @lazy get label() { … }
  }
  class Worklist {
    @observable accessor selectedId: string | null = null
    readonly row = companion((issue: IssueModel) => new WorklistIssue(issue, this))
    @lazy({ equals: compareShallow }) get roots(): IssueModel[] { … }
  }
  // the desktop sidebar and the phone Work tab: different components, same Worklist
  const Row = observer(({ issue }: { issue: IssueModel }) => {
    const row = useWorklist().row(issue)
    return <div>{row.label} · {issue.stage}</div>
  })
  ```
- **Keep a value still while a view is open:**
  ```ts
  class Launcher {
    @observable accessor repoOrder: string[] = []
    @action open() { this.repoOrder = sortByLatestActivity(this.repos) }
  }
  // the view's root component: useEffect(() => launcher.open(), [launcher])
  ```
- **Load on request:** an `@action` sets `loading = true` and awaits the call. Then, inside `runInAction`, it stores the result (or the error) and sets `loading = false`. It ignores a response that a newer request has superseded.
- **Create a record:** the form fields are UI state, and submitting calls the create command.
- **Edit a record with several fields:** call `const d = draftOf(issue)` when the form opens (import it from `@podium/client-graph/write/draft-of`; it is kept out of the package index so it stays out of the startup bundle). Inputs read and write `d.title` and `d.stage`; untouched fields keep following the live record. Use `d.isDirty` and `d.reset()`; `d.submit()` sends one combined edit. For another kind of record, write its `draftOf` with `draft(record, { fields, save })`. A single inline field keeps its text in its component.

## Testing a screen on an empty device

A pool without a loader cannot prove that a collection is complete: `held` and `treeHeld` answer `false`, and `status` and `treeStatus` answer `loading`. Putting rows in the pool does not establish completeness. The empty-device harness uses the real `MobxPool`, `CollectionLoader` and kernel Replica, a device that starts with only the policy collections of a real start, and a fake server that holds every record but answers only the instances the device asked for, recording each request.

Use it when a screen test checks data that is not guaranteed to be on the device: an issue's body (description, brief, todos, artifacts, deferred items, state line), any other record of group `body`, `windowed` or `byRule`, a closed or old record, or a record a view looks up by id. Use it too when the test is about what a screen asks the server for, or how it behaves offline.

A layout, Storybook or interaction fixture that intentionally supplies complete data declares that promise at its construction site:

```ts
import { fullDevice } from '@podium/client-graph/full-device-fixture'

const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
```

`fullDevice(pool)` explicitly vouches for the fixture's supplied collections, including empty ones: `held` and `treeHeld` answer `true`, and the status readers answer `complete`. It preserves the resident-row reader route, so parity tests still compare that route with the device-store implementation; it invents no loader, markers or stubs. It rejects a pool that already has a loader, and attaching a device store clears the declaration. Use this one helper for full-device fixtures in web, phone and `apps/web/harness`; a plain pool remains appropriate for a test of resident rows that needs no completeness claim. Never use the helper to fix a screen that does not ask for its data. Such a regression belongs on the empty-device harness, with content assertions.

- Screen tests: `mountOnEmptyDevice(element, { world })` from `apps/web/src/test-support/empty-device.ts`. Its header shows the three mocks that bind the app's pool and client-core hooks to the device. `untilIdle()` runs the device until the loader has nothing due; `requested()` and `requestedKeys()` list what was asked for; `offline()` and `online()` switch the connection; `commands` and `requests` record what the screen sent; `hold(instance)` holds an instance by hand, as a control.
- View-model tests: `openEmptyDevice({ world })` from `packages/client-graph/src/test-support/empty-device.test.fixture.ts`, and `observe(make, read)` to open a view model as a screen would.
- Write the world as the server syncs it: `putIssueWithBodies(server, id)` writes the issue record without its body fields and each body as its own record.
- Assert what the screen shows, and, where it matters, what it asked for. A known defect is an `it.fails` with a comment naming the task that fixes it, next to a passing test that mounts the same screen, so the expected failure cannot hide a screen that did not mount.

## What a change must show

- Before deleting old code: a test comparing old and new answers on the same fixtures, shown to fail when the new answer is wrong.
- The structural census (`bun run speed:structural`) flat or better than before.
- No view re-deriving a fact its shared model answers.
