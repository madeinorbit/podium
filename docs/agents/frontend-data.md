# Frontend data

How every client screen (web, desktop, phone) gets and derives data from the MobX pool in `packages/client-graph`. Follow it for all entities and all screens.

## Words

- **Entity**: a kind of server record (issue, session, worktree, repo, machine, conversation, …).
- **Shared model**: the one object per record, `pool.model('issue', id)` (`IssueModel`, `SessionModel`, … in `models.ts`).
- **Stored field**: server data. Declared once in `shared/schema.ts`, citing its zod definition in `@podium/model`; it appears on the model automatically.
- **Derived field**: a value worked out from other data, declared with `@lazy`.
- **View**: a feature the user sees: the worklist, the mission view, issue detail, the launcher, settings. One view can be drawn by several screens or platforms (the desktop sidebar and the phone Work tab both draw the worklist); they share the view's model and companions and differ only in components.
- **View model**: one class per view holding its UI state and handing out its companions. The view's root component creates it (or gets it from the app) and passes it down through React context.
- **Companion**: a small object per record, owned by one view, for rules only that view uses (`WorklistIssue` wraps an `IssueModel`). Created with `companion()`.
- **UI state**: state that never comes from the server: open tab, folds, selection, form input.
- **Watched read**: a read inside an `observer` component or a MobX reaction.

## Rules

1. **One shared model per record.** Every screen uses `pool.model(entity, id)`. Never build a second object holding facts about the same record. Group a model's fields by topic (stored fields, links, progress, close, history, presence) under heading comments.
2. **Derived fields are `@lazy` getters** (`@podium/mobx-helpers`). Nothing is allocated until a watched read; it is dropped when nothing watches. Reads outside screens (handlers, loops) are remembered for the length of the action, like `@computed`. Use `@lazy({ equals })` only for a small object rebuilt on each run. Do not use `makeObservable`/`makeAutoObservable` on shared models or companions, `computedFn`, `keepAlive`, or hand-made caches.
3. **Hand down models, read late, keep components small.** Pass a model, a companion or an ID; each small `observer` component reads only the fields it shows. Never pass a copied bundle of values through props or context: a copy does not update.
4. **Every question has one home.**
   - A fact about the record itself → the shared model.
   - A rule of one view → that view's companion, shared by every screen that draws the view. Never copy a view's rules into a second screen's own companion.
   - UI state → the view model, or the one component that uses it.
   - In doubt, ask: *would the answer change if this view worked differently?* Yes → companion. No → shared model.
   - Never re-derive in a view what the shared model answers. Create a companion class only when a view has its own per-record rules; otherwise pass the bare model.
5. **One field, one question, the narrowest answer.**
   - Each `@lazy` field answers one question. Bundle parts only if every reader needs all of them and they always change together.
   - Prefer an ID, a number or a boolean over an object.
   - For lists, pass on the data layer's own list (relation, declared subset, query result); it keeps its identity while unchanged. Do not copy it and do not write "compare with my previous result" code.
   - A count shown all the time over many records: the size of a declared subset in the schema when the rule reads only each record's own fields; otherwise one `@lazy` fact per record plus a `@lazy` total, up to about 10,000 records.
6. **Live by default; three declared exceptions.**
   - **On request**: an expensive or server-side answer wanted only when the user asks. The view model's action loads it into observable fields with a loading flag; nothing runs before or after.
   - **Stored on open**: a value that must not move under the user, or is expensive while its data changes constantly. The view model's `open()` action stores it; it is taken again on the next open. Never on shared models.
   - **Edit draft**: a form editing an existing record works on a `draft()`; untouched fields keep following the live record.
7. **Work over the working set, not all history.** Live lists and counts cover open records, recently closed ones and what a view shows; all-history questions are "on request". Never assume every row is in memory: read through models or `MobxPool.row`, index only resident rows, describe unloaded rows with a declared summary, and treat an absent row as `LOADING` with a batched load.

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
    @lazy get roots(): WorklistIssue[] { … }
  }
  // desktop sidebar and phone Work tab: different components, same Worklist and rows
  const Row = observer(({ row }: { row: WorklistIssue }) => <div>{row.label} · {row.issue.stage}</div>)
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
- **Edit a record with several fields**: `const d = draftOf(issue)` when the form opens; inputs read and write `d.title`, `d.stage`; `d.isDirty`, `d.reset()`, `d.submit()` sends one combined edit. A single inline field keeps its draft text in its component.

## What a change must show

- Before deleting old code: a test comparing old and new answers on the same fixtures, shown to fail when the new answer is wrong.
- The structural census (work per change at 1× versus 4× data) flat or better than before.
- No view re-deriving a fact its shared model answers.
