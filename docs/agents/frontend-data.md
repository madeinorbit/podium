# Frontend data

How client code (web, desktop, phone) holds, derives and shows data. The data layer is the MobX pool in `packages/client-graph`; helpers come from `@podium/mobx-helpers`. Every frontend change follows this guide. Some homes named here are still being built: the shared clock (POD-5863), the three-answer lookup (POD-5867), the UiStore (POD-5797) and the LiveStore (POD-5798). Until one lands, leave that state where it is today, and add no new code in the old pattern.

## Where things live

| What | Home |
|---|---|
| Facts about a server record | its **shared model**, `pool.model(entity, id)` (`models.ts`). Stored fields: one line in `shared/schema.ts` citing the zod type in `@podium/model`. Derived fields: `@lazy` getters. |
| A rule of one view about a record | that view's **companion** (`WorklistIssue` wraps an `IssueModel`), made by `companion()` on the view model |
| A view's UI state (tab, folds, selection, form input) | the **view model**, or the one component that uses it |
| App-wide screen state saved on this device (open view, panes, tabs, focus) | the **UiStore** |
| Live server values that are not records (connection, quota, usage) | the **LiveStore**: pushed by the server, never saved, each value replaces the old |
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
   - Read rows through models or `MobxPool.row`. Index only rows in memory; the one exception is the cold index (`shared/cold-index.ts`) with its relation index, which hold only the declared fields and links the working-set rule needs. Describe rows not in memory with a declared summary.
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
   - The only "ID → object" maps allowed are: the pool's models, `companion()` maps, the view registry (`pool.sources.view`) and the data layer's indexes.
   - A view that opens and closes gets a new view model per opening. Its root component creates it, and closing drops it together with its companions. Anything that must survive a reopen goes into the UiStore, on purpose.
   - Always-on views (the worklist) keep one view model.
10. **Time.**
    - The current time comes from the shared clock, which ticks only while something watches it, at the reader's precision (seconds under an hour, minutes above). Only small label and timer components read it. No `Date.now()` in derived fields, and no intervals in components.
    - A change due at a known moment (a record leaving a list, evidence expiring, a snooze ending) is a deadline: one timer for the next due one, re-checked when the app wakes, becomes visible or regains focus.
    - Polling runs only while its view is visible; a server push replaces it wherever possible.

## How to

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

## What a change must show

- Before deleting old code: a test comparing old and new answers on the same fixtures, shown to fail when the new answer is wrong.
- The structural census (`bun run speed:structural`) flat or better than before.
- No view re-deriving a fact its shared model answers.
