# Frontend data

How every client screen (web, desktop, phone) gets and derives data from the MobX pool in `packages/client-graph`. Follow it for all entities and all screens.

## Words

- **Entity**: a kind of server record (issue, session, worktree, repo, machine, automation, message, …).
- **Shared model**: the one object per record, `pool.model('issue', id)` (`IssueModel`, `SessionModel`, … in `models.ts`).
- **Stored field**: server data. Declared once in `shared/schema.ts`, citing its zod definition in `@podium/model`; it appears on the model automatically.
- **Derived field**: a value worked out from other data, declared with `@lazy`.
- **View**: a feature the user sees: the worklist, the mission view, issue detail, the launcher, settings. One view can be drawn by several screens or platforms (the desktop sidebar and the phone Work tab both draw the worklist); they share the view's model and companions and differ only in components.
- **View model**: one class per view holding its UI state and handing out its companions. The view's root component creates it (or gets it from the app) and passes it down through React context.
- **Companion**: a small object per record, owned by one view, for rules only that view uses (`WorklistIssue` wraps an `IssueModel`). Created with `companion()` from `@podium/mobx-helpers`, declared once on the view model: one companion per record per view. Never use `companion()` as a cache for part of a row; that part is a `@lazy` field of the companion.
- **Request answer**: a one-off server answer to one question (search hits, a file tree, a git diff, a receipt). It is not a record and has no shared model.
- **Service**: an object with a job and a lifetime that is not a record: a conversation's transcript window, streaming and send queue; the connection; the outbox. Written in the rule 8 style. Services own their reactions; screens never read a service directly.
- **Edit draft** and **message draft**: an edit draft holds a form's unsaved changes to an existing record (`draft()`, local to the view). A message draft is the chat text being typed to an agent: a stored field of the session, synced to other devices; never built with `draft()`.
- **UI state**: state that never comes from the server: open tab, folds, selection, form input.
- **UiStore**: the app-wide screen state saved on this device (which view is open, selection, panes, tabs, open files, focus), read before the first paint.
- **LiveStore**: current server values that are not records (connection, quota, usage), pushed by the server, never saved; each new value replaces the old. A live value of a record (a machine's load) is a field on that record's shared model (rule 1).
- **Watched read**: a read inside an `observer` component or a MobX reaction.

## Rules

1. **One shared model per record.** Every screen uses `pool.model(entity, id)`. Never build a second object holding facts about the same record. Group a model's fields by topic (stored fields, links, progress, close, history, presence) under heading comments.
2. **Derived fields are `@lazy` getters** (`@podium/mobx-helpers`). Nothing is allocated until a field is read; it is dropped when nothing needs it. Reads outside screens (handlers, loops) are remembered for the length of the action, like `@computed`, and outside an action until the current synchronous code has finished, so read fields directly instead of copying them into locals. Use `@lazy({ equals })` only for a small object rebuilt on each run, or a list (rule 5). Do not use `computedFn`, `keepAlive`, or hand-made caches.
3. **Hand down models, read late, keep components small.** Pass a model, a companion or an ID; each small `observer` component reads only the fields it shows, under the field's own name. No adapter objects or Proxies that rename fields for a component: pick the right name once on the model or companion and every component uses it. Never pass a bundle of copied values through props or context: one rebuilt in a derived field updates, but every reader redraws when any part changes; one copied once (in a constructor, React state or a ref) goes stale.
4. **Every question has one home.**
   - A fact about the record itself → the shared model.
   - A rule of one view → that view's companion, shared by every screen that draws the view. Never copy a view's rules into a second screen's own companion.
   - UI state → the view model while the view is open, or the one component that uses it; app-wide screen state that is saved on the device → the UiStore. Store each piece once: one `selectedId`, and each row derives `@lazy get selected() { return this.worklist.selectedId === this.issue.id }`. A value that follows from other state (such as "the selected record is gone", from the sync replica's `exitKind`) is a derived field, never a second field kept in step by a reaction.
   - In doubt, ask: *would the answer change if this view worked differently?* Yes → companion. No → shared model.
   - Never re-derive in a view what the shared model answers. Create a companion class only when a view has its own per-record rules; otherwise pass the bare model.
5. **One field, one question, the narrowest answer.**
   - Each `@lazy` field answers one question. Bundle parts only if every reader needs all of them and they always change together.
   - Prefer an ID, a number or a boolean over an object.
   - For lists, pass on the data layer's own list (relation, declared subset, query result); it keeps its identity while unchanged. A list a view builds is a `@lazy({ equals: compareShallow })` field: MobX keeps the old array while the members are the same. Do not write "compare with my previous result" code. Lists hold shared models, or IDs for records that may not be loaded; a row component gets its companion from the view model.
   - A count shown all the time over many records: the size of a declared subset in the schema when the rule reads only each record's own fields; otherwise one `@lazy` fact per record plus a `@lazy` total, up to about 10,000 records.
6. **Live by default; three declared exceptions.**
   - **On request**: an expensive or server-side answer wanted only when the user asks. The view model's action loads it into observable fields with a loading flag; nothing runs before or after.
   - **Stored on open**: a value that must not move under the user, or is expensive while its data changes constantly. The view model's `open()` action stores it; it is taken again on the next open. Never on shared models.
   - **Edit draft**: a form editing an existing record works on an edit draft (How to); untouched fields keep following the live record.
7. **Work over the working set, not all history.** Live lists and counts cover open records, recently closed ones and what a view shows; all-history questions are "on request". Never assume every row is in memory: read through models or `MobxPool.row`, index only resident rows (the one exception is the cold index, `shared/cold-index.ts` with its relation index: only the declared fields and links the working-set rule needs, for every known row), describe unloaded rows with a declared summary. A record that is not in memory has exactly one of three answers, and every caller handles all three: **here** (the model), **on its way** (`LOADING`: not loaded yet, or dropped from memory; a batched load is started), or **gone** (deleted on the server, or not visible to this user; with the reason). Never show "on its way" for a record that is gone.
8. **One way to write state**, in every class (shared models, companions, view models, services):
   ```ts
   @observable accessor tab = 'chat'                // a value
   @observableRef accessor layout: Layout = {}      // replaced whole, never changed inside
   readonly folded = observable.set<string>()       // a collection whose contents change
   @action fold(id: string) { this.folded.add(id) } // changes
   @lazy get visibleCount() { … }                   // derived
   ```
   App code does not use `observable.box`, `makeObservable` or `makeAutoObservable`. `createAtom` and `new Reaction` stay inside the data layer and `@podium/mobx-helpers`.
9. **What may be kept, and for how long.**
   - "ID → object" maps exist only as: the pool's one model per record, `companion()` maps, the view registry, and the data layer's indexes (cold index, relation index). Any other is a hand-made cache (rule 2).
   - A view that opens and closes (issue detail, settings, launcher, mission) gets a new view model per opening: its root component creates it, and closing drops it with all its companions. Anything that must survive a reopen, such as a chosen tab, is stored on purpose in the UiStore.
   - Views that are always on (the worklist) keep one view model for the session.
10. **Server data: shared model or request answer.**
   - Anything the server sends that has an ID, can change while the user looks, and is shown in more than one place is a record: it gets a schema entry and a shared model, whether it arrives through sync or through a request. A request that returns records puts them into the pool; the view keeps only their IDs.
   - Everything else is a request answer: the view model that asked holds it with its loading and error state (rule 6, "on request"), and it is dropped when the view closes.
   - Never write a derived value into a stored record; it is a `@lazy` field (rule 2).
   - A conversation is split: its record facts live on the shared session and message models; the transcript window, streaming text and send queue are a service, one per open conversation, kept warm in a small cache.
11. **Time.**
   - The current time comes from one shared clock in `@podium/mobx-helpers` that ticks only while a watched reader needs it, at the precision the reader asks for (every second under an hour, every minute above for age labels). Nothing reads `Date.now()` in a derived field, and no component starts its own interval.
   - Something that changes at a known moment (a closed record leaving a list, evidence expiring, a snooze ending) is a deadline: one timer for the next due deadline wakes only what is due; all deadlines are re-checked when the app wakes, becomes visible or regains focus. Built on `createAtom` with `onBecomeObserved`, the pattern MobX documents for custom observables and mobx-utils `now()` uses.
   - Only the small label or timer component reads the time; rows, pages and lists never do.
   - Repeated server checks (polling) run only while their view is visible; a server push replaces them wherever possible.

## How to

- **Add a stored field**: one line in `shared/schema.ts` with its zod citation.
- **Add a derived field**: an `@lazy` getter in the right topic group of the model or companion (rule 4).
- **Add per-record rules for one view**:
  ```ts
  class WorklistIssue {
    constructor(readonly issue: IssueModel, private readonly worklist: Worklist) {}
    @lazy get label() { … }
  }
  class Worklist {
    @observable accessor selectedId: string | null = null
    readonly row = companion((issue: IssueModel) => new WorklistIssue(issue, this))
    @lazy({ equals: compareShallow }) get roots(): IssueModel[] { … }
  }
  // desktop sidebar and phone Work tab: different components, same Worklist and rows
  const Row = observer(({ issue }: { issue: IssueModel }) => {
    const row = useWorklist().row(issue)
    return <div>{row.label} · {issue.stage}</div>
  })
  ```
- **Keep a value still while a view is open**:
  ```ts
  class Launcher {
    @observable accessor repoOrder: string[] = []
    @action open() { this.repoOrder = sortByLatestActivity(this.repos) }
  }
  // view's root component: useEffect(() => launcher.open(), [launcher])
  ```
- **Load on request**: an `@action` on the view model sets `loading = true`, awaits the call, then stores the result and `loading = false` (in `runInAction` after the await).
- **Create a record**: form fields are UI state; submit calls the create command.
- **Edit a record with several fields**: `const d = draftOf(issue)` (import from `@podium/client-graph/write/draft-of`; it is not in the package index, to keep it out of the startup bundle) when the form opens; inputs read and write `d.title`, `d.stage`; `d.isDirty`, `d.reset()`, `d.submit()` sends one combined edit. For another kind of record, write its `draftOf` the same way, with `draft(record, { fields, save })` from `@podium/mobx-helpers`. A single inline field keeps its draft text in its component.

## What a change must show

- Before deleting old code: a test comparing old and new answers on the same fixtures, shown to fail when the new answer is wrong.
- The structural census (work per change at 1× versus 4× data) flat or better than before.
- No view re-deriving a fact its shared model answers.
