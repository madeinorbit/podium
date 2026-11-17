# Data on the device (POD-7059)

Status: agreed with the operator on 2026-11-17. Design only; nothing is built. One decision is
open: [tree preloading](#open-decision-tree-preloading).

This design answers one question for the start-up phase (POD-5910) and the memory phase
(POD-5211): which data is on the device and in memory at any moment, how it gets there, and how
it leaves.

## Summary

1. The device holds **collections**, not "everything". A collection is a declared rule over a
   record's own fields. The device knows for each collection it holds that it is complete.
2. Every issue is on the device at least as a **stub**: reference, state and parent. Counts and
   links work from stubs, for all history, without the full records.
3. The **server's policy** says which collections each client type holds at all times. An open
   view holds what it shows. Everything else on the device is cache.
4. There is **one loader and one fetch route**. The first download is the first batch of
   fetches, in a fixed order.
5. The **feed** keeps delivering every change the user may see. The client applies a change to
   what it holds and ignores the rest.
6. Everything on the device is also **in memory**. History is not on the device, so memory is
   bounded by the policy and a cache cap, not by the size of the history.
7. Records, their parts, their links and the collections are written down **once**, in the
   shared model package. Server and client both read that declaration.

## Why

Checked in code on `dev/mw` (9df52ede2f):

- The server's start-up load streams every record of every kind, including the brief and
  description of every issue (`apps/server/src/sync-worker/producer.ts`).
- The client's storage reads the whole store into a memory copy at start
  (`packages/sync/src/adapters/indexeddb/store.ts`, `hydrate()`; the phone store has the same
  shape).
- The client keeps indexes over every record, including history: a field index, a relation
  index and question buckets (`packages/client-graph/src/shared/cold-index.ts`,
  `relation-index.ts`, `reader-questions.ts`). Full model objects exist only for active work.
- The only completeness marker is one for personal rows
  (`packages/sync/src/replica/cache-completeness.ts`).
- The phone's storage uses the synchronous SQLite calls, so reading the store at start blocks
  the app's thread (`packages/sync/src/adapters/mobile-sqlite/sql.ts`).

Measured on the operator's instance (backup of 2026-11-16, read in place):

| Fact | Number |
|---|---|
| Issues | 8,687, about 2,000 new per month |
| Issues done / proposed | 4,977 / 1,859 |
| Sessions (live) | 6,941 (247) |
| Synced records, size as JSON | about 38,000, about 58 MB (estimate) |
| Issue briefs | 20 MB |
| Open issues that are not proposed (the sidebar) | 1,563 |
| Issues changed in 7 days / 30 days | 388 / 1,530 |
| Sessions active in 7 days / 30 days | 290 / 740 |

Read in earlier measurement notes, not measured again: history times ten makes the heap four
times larger and the cold start 3.7 times slower (POD-4747); the start-up cost is building
indexes over all rows and the storage commit (POD-5239, POD-5513).

So both start-up time and memory grow with history. The design removes history from the device
except for what the user opens.

## Vocabulary

| Term | Meaning |
|---|---|
| Record | One thing the server syncs, with an ID: an issue, a session, a repository. |
| Part | A fixed group of a record's fields. Each field is in exactly one part. |
| Stub | The smallest part of an issue: reference, state, parent. |
| Collection | A declared rule over a record's own fields, plus the part it delivers. "Open issues that are not proposed, main part." |
| Instance | A collection with its arguments filled in: "the tree under issue X". Definitions are few; instances are many. |
| Marker | The note "this instance is complete". |
| Comes with | Holding a record also holds what a declared link reaches: a session comes with its issue; a sidebar issue comes with its sessions that are not archived. |
| Policy | Server data per client type: which collections the client always holds, in which order they load, and the numbers (days, cache cap). |

## The design

### One shared declaration

Each record type is declared once in `@podium/model` with a small `defineRecord` helper on top
of the zod types that already exist. No new schema framework.

The declaration holds:

- the fields and which part each belongs to;
- the links to other record types, and which of them a record comes with;
- the collections over this record type.

A collection rule is data, not code, because the server must run it as SQL and the client as
JavaScript:

```ts
{ of: 'issue', part: 'main', where: { stage: { in: OPEN_STAGES }, archived: false } }
```

The allowed tests are: equals, one of, is empty, newer than N days, and descendants of a record
(through the parent link). Nothing else. A screen that needs a different question gets a new
collection definition, never a special case in the loader.

From the declaration the build generates the wire record lists and the client's type lists,
which are written by hand today (`kernel/kinds.ts`, the protocol's change list). The server's
record builders stay code; they register against the declaration, and a test holds them to it.
Builders for kinds that are one database row become declarative (19 of 33 kinds, by the audit
quoted in `apps/server/src/sync/record-builders.ts`).

### Parts

| Part | Content | On the device |
|---|---|---|
| Stub | Reference, state, parent (issues only) | For every issue |
| Main | The other slim fields: title, priority, dates, links | With a collection that is held |
| Body | Brief and description | When the issue is opened |
| Live | Values that change every second: busy, last input, context use, terminal size, machine load | While something watches them; never stored |

Per record the device holds exactly one row. It is a stub or it has more parts. Loading the main
part fills the row; trimming removes parts again and never needs a fetch.

How the parts travel differs, and the declaration is what they share:

- **Stub and main** are one wire record. The stub is the declared stub fields picked from it, so
  state and parent have one home and can never disagree. The stub needs no builder and no kind
  of its own on the feed. The only new thing on the wire is that a fetch can answer at stub
  level.
- **Body** stays what it is today, separate records for brief and description, so that a small
  change to an issue does not send two kilobytes of text again.
- **Live** values are pushed while watched. One generic store built from the declaration
  replaces the hand-written live store. This covers the hot session values directly and does not
  wait for POD-6811. Live readings that belong to no record (connection, quota, unsent writes)
  stay as they are.

Only issues, sessions and machines have more than one part.

The issue stub is fixed:

| Group | Fields |
|---|---|
| Reference | ID, repository, number |
| State | Stage, closed reason, archived, deleted, draft, agent-owned |
| Parent | Parent ID |

It holds nothing for display and **must not grow**. A screen that wants another field over all
history gets its answer from the server (see [Counts](#counts)), not from a wider stub.

The stubs are held in memory as a compact table, because the terminal colours references while
it paints and needs the answer at once. Estimates, not measured:

| Issues | On disk | In memory |
|---|---|---|
| 8,687 (today) | about 1 MB | about 1.3 MB |
| 50,000 | about 5 MB | about 7.5 MB |

This is the one thing that grows with history, which bends the rule "bound growth by design".
The policy can cap it per client type, but counts over all history then stop being exact, so
the cap is a last resort.

Sessions have **no stub**. The questions that seemed to need one do not
(see [Where each question gets its answer](#where-each-question-gets-its-answer)).

### Collections

| Collection | Rule | Held by |
|---|---|---|
| Always | The record types that do not grow with history | Policy |
| Live | Sessions that are starting or live | Policy |
| Recent | Issues and sessions changed in the last N days | Policy |
| Sidebar | Open issues that are not proposed | Policy |
| Sessions with no issue | Not archived, no issue (the sidebar's lanes) | Policy |
| Issue stubs | Every issue, stub part | Policy |
| Tree | All issues under one top-level issue | The view that opens it |
| Page | One page of a sorted list: a board column, the proposal deck | The view that shows it |
| Sessions of one issue | Sessions with that issue | What it comes with; the issue page |
| One record | That ID | A lookup that finds the record absent |

The sidebar collection holds all open issues that are not proposed, because the operator
expects to see everything left there. It grows with open work, not with history. The operator
decided to leave it uncapped until it becomes a problem.

"Recent" reads a time saved on the record: an issue's last-change time, and for a session the
coarse activity time its record carries. It never reads a live value. Every field a rule reads
must be a saved field.

Definitions are few, perhaps fifteen to twenty. Instances are many, one per thing the user
opened, and each costs one small marker. The cost of applying a change depends on the number of
definitions, not instances: one lookup per definition ("do I hold the sessions of this
session's issue?"). The client's reader index already files each record into named buckets from
its own fields; those buckets are collection rules already, and they stay.

A sorted, paged collection keeps a range marker: "complete from the top down to this position".

**Comes with.** Some records are needed because of another record, which their own fields
cannot say. One declaration covers both directions:

| A held record | Comes with |
|---|---|
| Any issue | Its parents, the user's read state for it, its git state, its dependencies |
| Any session | Its issue, the user's state for it, its pending interactions |
| An issue in the sidebar | Its sessions that are not archived |
| An issue in a tree a flight deck shows | Its sessions that the deck shows |

```ts
{ of: 'issue', part: 'main', where: SIDEBAR,
  comesWith: [{ collection: 'sessionsOfIssue', where: { archived: false } }] }
```

The first two rows are declared on the record type and hold for every collection. The last two
are declared on a collection. Nothing new is stored for either: what comes along is an ordinary
record or an ordinary instance of a keyed collection, with its marker. The server answers it
with one join. The client requests it when a record enters a collection and releases it when
the record leaves. This is the usual "include the related records" of query systems.

On the operator's data, parents add about 60 issues; the sidebar's sessions are 720, of which
577 were last active more than 30 days ago.

**Which record types go where.** To be confirmed per kind in the declaration task (counts from
the operator's data):

| Group | Record types |
|---|---|
| Always | repository, machine, machine access, checkout, agent profile, automation, preferences, layout, tab order, pins, subscriptions, read position, workflow, workflow binding and revision, ship lane and order, superagent thread |
| Comes with its issue | the user's issue state (8,707), git state (411), dependencies (6,505) |
| Comes with its session | the user's session state (1,936), pending interactions (34) |
| By rule, like issues and sessions | workflow runs (260), automation runs, native conversations (3,712): recent by policy, older by page |
| Already windowed by the server | messages, issue events |

### Policy

The server holds one policy per client type. The client says what it is (phone, browser,
desktop) and receives the policy in the load header. The client never chooses.

| Client | Recent | Cache cap |
|---|---|---|
| Phone | 7 days | Small, from measurement |
| Browser | 30 days | From measurement |
| Desktop | 30 days | Larger, from measurement |

On the operator's data the phone policy holds about 2,000 full issues instead of 8,687.

What a server-side policy gives:

- Numbers change without a client release. A phone app takes days to ship.
- A hosted server can cap what any client loads, and tune it per workspace.
- "Keep more on this device" is a server-side setting that follows the user to a new device.

When the policy for a client changes, the client fetches the difference or lets the surplus
become cache.

The server does not stamp records with their collection. A rule reads the record's own fields
and the date, so the client can decide by itself what a change means.

### One loader, one route

The client has one loader. Its input is a list of instances; its output is whole records in
feed format plus a marker per instance. It collects requests for 50 ms, removes duplicates, and
fetches what the answers come with.

The server has one generic fetch route beside the existing `/sync/bootstrap` and `/sync/delta`
stream routes. It is not tRPC with an endpoint per screen and not GraphQL: the question is
always an instance, and the answer is always whole parts of records.

The first download is the first batch, in this order:

1. Always and live. The first screen can paint.
2. What the visible view asks for.
3. Recent.
4. Sidebar, with what it comes with.
5. Issue stubs.

Each collection is installed in chunks and its marker is written last. A download that is
interrupted resumes at the first collection without a marker. This replaces the single large
install that loses everything when the app closes early (POD-7048).

Later starts read the disk and ask the feed for the changes since the stored feed number.
Nothing else is fetched.

If the feed cannot bridge the gap (the device was offline for longer than the server keeps its
log), the markers are dropped and the collections load again. During that reload the old rows
stay on screen and are replaced as fresh ones arrive; counts show loading until their
collection is complete again.

### The feed

The feed is unchanged on the server: it delivers every change the user may see, as whole slim
records. The client decides per change:

| The device holds | What the client does |
|---|---|
| The record with its main part | Replaces it |
| The issue as a stub, and the change does not match a held collection | Updates the stub fields |
| The issue as a stub or not at all, and the change now matches a held collection (an old issue is reopened) | Keeps the full record and fetches what it comes with |
| Nothing, and no held collection matches | Ignores it |

A deletion or a loss of visibility gives the lookup answer "gone". Because the feed is applied
without gaps, a collection that was complete stays complete.

Three rules make this safe:

- **The newer one wins, per record.** A fetch answers as of some feed number, which can be ahead
  of what the device has applied. Each stored record therefore keeps the feed number it is
  current as of, and a change older than that is skipped for that record. Today the client has
  one cursor for everything (`packages/sync/src/replica/replica.ts`), which is not enough once
  collections arrive separately.
- **One snapshot per answer.** The server reads a collection and the feed number it is complete
  as of in one snapshot, also with several server processes on Postgres.
- **Tree membership needs no walk.** A tree that is complete holds all its members, so a new
  issue belongs to it exactly when its parent does.

### Lookup

Looking up a record keeps its three answers: here, on its way, or gone. There is no fourth
"may be outdated" state. A stub is "here" for a reader that asks only for stub fields and "on
its way" for a reader that asks for more; the loader then fetches the missing part.

Without a connection, a load cannot start. The view then shows "not available offline" from the
connection state it already knows, not an endless loading row. That is the view's reading of "on
its way", not a new answer.

A command on a record the device does not hold makes no optimistic change; its result arrives
through the feed.

### Memory, cache and leaving

Everything on the device is also in memory. The cache cap is therefore the memory cap.

- Storage reads stay synchronous, from memory.
- Indexes cover only rows in memory, which now means the rows on the device. The index over all
  history, its relation index and the active-work rule are deleted.
- **Two things hold an instance:** the policy, and an open view. An instance that neither holds
  is cache.
- **The cache is trimmed by instance,** not by record: when it is above its cap, the instances
  released longest ago are dropped whole, with their markers. A record leaves when no remaining
  instance contains it and no held record comes with it. An issue then falls back to its stub;
  other records are removed.
- **Nothing moves a record when its days pass.** A view that lists "recent" filters by the clock
  as it reads, and a record that no longer matches is simply not counted as held at the next
  trim. The trim is the only sweep, and it need not be prompt, because holding extra records
  never makes a list wrong.

**One copy in memory.** The earlier memory work in this epic found that row copies were never
the cost: a row is about 550 bytes, and the storage copy, the sync engine's lists and the data
layer all point at the same row objects (POD-5133). The cost was the indexes over history. So
"one copy" is reached by removing history from the device, not by changing who owns the rows.

Estimates for this design, not measured, using that work's figure of 1 to 5 KB per record held
with its indexes:

| | Phone | Desktop |
|---|---|---|
| Policy collections: issues and sessions, plus their small companions | about 3,000 issues and sessions, 5 to 10 MB | about 4,000, 10 to 20 MB |
| Cache | a small cap, a few MB | 5,000 to 10,000 records, 10 to 40 MB |
| Stubs | 1 to 2 MB | 1 to 2 MB |
| Today, for comparison | 65 to 80 MB on the phone fixture | about 90 MiB |

The four rules pinned on the earlier memory work stay in force (POD-5212): rows are read
through one reader; indexes cover only rows in memory; a record not in memory is described by a
small declared summary, which is now the stub; an absent row answers "on its way" and starts a
batched load.

The operator agreed to "everything on the device is in memory" with "unsure but yes". The way
back stays open:

- **How to change it:** the loader gets a second source, the disk, so that a record can be on
  disk without being in memory. Screens do not change, because they already handle "on its way".
- **What would trigger it:** measured memory on the phone above an agreed limit, or a cache cap
  that turns out too small to be useful.

Moving the sync engine to a worker was considered and deferred until measured. The trigger would
be main-thread time spent parsing the feed and writing to storage. Screens read live objects, so
models and indexes have to stay on the main thread in any case.

### Counts

One rule: a collection that is complete on the device is counted locally. Otherwise the count
arrives with the fetch.

- Counts by stage and by repository, child counts and tree progress come from the stubs. They
  are exact, local and cover all history.
- A count under a filter that the stub cannot answer (priority) arrives with the first page of
  that list, counted for that viewer, and is refreshed when the page is fetched again. The
  server already has a count by stage, priority, type and assignee (`issues` service, `count`).
- On an empty device the stubs arrive last. Until they are complete, a count over all history
  shows loading. A view that needs the numbers first asks for its tree at stub level, which is
  small.
- There are no count records on the server. They were rejected because a count shared between
  viewers can include records one viewer may not see.

### Search and references

- Search shows results from the device at once and then results from the server. The command
  palette already works this way. The server search it uses exists
  (`trpc.issues.searchNormalized`, added 2026-10-02): it matches title, description and brief,
  with the viewer's rights. It scans; an index for it, and search over transcripts, stay with
  POD-5617. Mentions, pickers and the board's text filter move to the same pattern.
- A link or chip to an issue reads the stub: it knows the reference and the state at once. A
  reference to a record that is absent starts a batched load, like any other lookup.

## Open decision: tree preloading

Agreed earlier and still in force until the operator decides otherwise: the policy also
preloads whole trees of up to 50 issues for the sidebar's top-level issues, and on the desktop
the big trees that have live work. Both would be declared as "comes with" on the sidebar and
live collections, with a condition on the tree's size.

Recomputed on the operator's data (issues on the device, of 8,687):

| Option | Phone | Desktop |
|---|---|---|
| No tree preloading | about 2,000 | about 2,830 |
| Plus whole trees up to 50 issues | about 2,670 | about 3,410 |
| Plus big trees with live work (desktop rule) | — | about 5,130 (59%) |
| Every tree in full | about 5,240 (60%) | about 5,750 (66%) |

The limit of 50 was set to keep the few giant trees off the device, and it does. The desktop
rule brings ten of them back and puts 59% of all issues on a desktop. The reason for preloading
that remains is a faster first opening of a flight deck: counts are exact from the stubs
either way, the open members are in the sidebar collection, and a tree that was opened stays on
the device. Without preloading, 75 small trees load about nine closed issues each on their
first opening.

Recommendation: drop the desktop rule; the small-tree rule is cheap in data but is the only
rule that depends on a tree's size, so drop it too and bring it back if first openings prove
slow.

## Two examples from an empty device

**A small tree (12 issues).** Always and live arrive and the first screen paints. Recent, the
sidebar and the stubs follow. Opening the tree's flight deck shows its open members and exact
progress at once; the closed members arrive with one short fetch (none, if small trees are
preloaded).

**A big tree (970 issues, 922 closed), opened straight after install.** Always and live arrive;
the members with running sessions are in the live collection, so the deck's working and
needs-you rows paint with the first screen. The deck is the visible view, so its tree goes to
the front of the queue: first at stub level, which gives "922 of 970", then the full records,
which fill in the phases and done members as they arrive. The rest of the first download
continues behind it. After that the tree stays on the device and the feed keeps it current.

**The second start, for both.** Everything comes from disk, with no fetch and no loading rows.
The feed delivers what changed while the app was closed.

## Where each question gets its answer

Every question that today reads all history was traced to the feature that asks it. None of
them needs all issues or all sessions. The survey was done per kind of question (about 45 query
methods in about 35 files); not every call site was read.

| Feature | What it needs | Answer |
|---|---|---|
| Sidebar | Open issues that are not proposed, with their sessions; sessions with no issue | Sidebar collection and what it comes with; the sessions-with-no-issue collection |
| Flight deck, issue page | Members of one tree, links, sessions of its issues | Tree collection and what it comes with |
| Progress bars and child counts | Parent and state of every member | Stubs |
| Links and chips in chat and terminal | Reference and state | Stubs; an absent record loads in a batch |
| References to sessions in chat and terminal | The session's status | The session if held; otherwise a batched load. Old session references are not coloured until loaded, because sessions have no stub |
| Header, explorer, shell | Live and recent sessions | Live and recent collections |
| Which issue owns this folder (header, shell) | Open issues with a worktree | Sidebar collection |
| Board columns | Issues of one stage, sorted | A collection per stage: what the device holds shows at once, the rest (proposed, done) arrives by page |
| Board counts by stage or repository | Stage and repository of every issue | Stubs |
| Board counts under a priority filter | A filtered total | Arrives with the page |
| Board filter menu | The possible assignees, labels, projects | Their own records, not a walk over every issue |
| Command palette | Recents; matches for typed text | Device, then server search (works this way today) |
| Mention in chat | The five best matches | Device, then server search |
| Phone "link to task" picker | Matches in one repository; "is there any other task" | Device, then server search; stubs |
| Position of a new task | The current top of the list | The sidebar collection |
| Proposal screening on the phone | The next cards and a count | Page collection; count from stubs |
| Phone inbox and sessions screens | — | No longer reachable; the code is deleted |
| First-run setup screen | Whether setup is finished | An explicit server answer (POD-7093) |
| Default agent in setup | The agent of the latest session | The latest session on the device, else the default |
| Workflow or automation run pointing at a session | That one session | An ordinary lookup |
| "Sessions: N" in phone settings | A diagnostic | The number on the device |
| Hiding duplicate sessions | The two records, when both are on the device | The existing rule, over sessions in memory |

Two of these have a history worth keeping:

- **Duplicate sessions.** Two session records can point at the same agent conversation, and the
  client hides the less useful one. A unique key on the server was considered and withdrawn
  (POD-7092 cancelled): the resume key is an observation, and two records can share it for
  real (a headless session and its terminal session; a parked record and a live session that
  attached to the same conversation). The server already arbitrates two live sessions
  (`apps/server/src/modules/sessions/session-binding.ts`). The record the client keeps is the
  live or more recently active one, which the policy holds whenever it holds the other.
- **Setup.** The setup screen starts when there are no repositories and no sessions, and since
  2026-11-09 it also counts sessions to detect a stale "setup in progress" flag left on devices
  by builds that read zero counts by mistake. The cause is that setup is inferred from counts,
  and with partial data a count on the device proves even less. The server will answer "setup
  is finished" next to "this person sets up the server", and the repair goes.

## What is deleted

- The memory copy of all history and the start-up load of every record, including the brief of
  every issue (20 MB today).
- The index over all rows with its relation index (`cold-index.ts`), and the summaries that
  describe rows not in memory.
- The active-work rule (`packages/model/src/predicates/active-work.ts`); the policy and the
  collections replace it.
- The phone's inbox and sessions screens with their readers.
- The hand-written kind lists and the hand-written live store.

There are no compatibility paths for old clients. The wire version changes once, on the
integration branch.

## Approaches considered

| Approach | Why not |
|---|---|
| One rule sized for the smallest device | Rejected by the operator as limiting. The server policy per client type replaces it. |
| The client picks its own sets | A dumber client is easier to change; the server holds the policy. |
| The client reports network and storage facts | No policy uses them. Added when one does. |
| The server stamps each record with its set | Not adopted; the operator was unsure. The rule reads the record's own fields, so no stamp is needed. |
| Query-driven sync like Zero (any query, cached for minutes) | Needs per-client query state on the server. Views holding declared collections gives the useful part without it. |
| Count records kept by the server | A shared count can include records a viewer may not see. |
| Load every sub-issue of every kept tree | 60% of all issues on a phone, driven by a few long-running trees. |
| An issue always comes with all its sessions | Done issues carry 3,250 sessions that are not archived; every opened tree would pull thousands. |
| A "may be outdated" fourth lookup state for cached records | The feed keeps cached records current, so every screen handles three answers, not four. |
| A separate stub record type | Two homes for state and parent can disagree. The stub is a part of the issue record. |
| A stub for sessions | No feature needs a fact about every session. |
| A wider stub (priority, title, dates) | The stub would become the record. Its three-part rule is fixed. |
| Arbitrary column subsets per collection (as ElectricSQL allows) | Fixed parts keep "one row per record, each field in one part". |
| A title index on every device for offline search | Grows with history. It stays possible later as one more part. |
| Trimming the cache record by record | It would make a cached instance's marker false. |
| Memory holds only what open views read | Indexes would be rebuilt on every navigation; the earlier memory work warns against that (one rename read 3,798 rows without incremental indexes). |
| Policy collections in memory, the cache on disk only | Kept possible behind the loader. Not chosen now: it makes the storage interface asynchronous for no visible gain at these sizes. |
| The sync engine in a worker | Deferred until measured. |
| GraphQL for the fetch route | Its strength is per-screen field selection, which this design avoids on purpose. |
| Adopting a sync product (Zero, ElectricSQL, PowerSync, TanStack DB) | Each replaces the sync log, the store or the model layer that exist, and none runs on both SQLite and Postgres. |
| A schema framework (Effect Schema, TypeSpec, a move to zod 4) | A thin `defineRecord` on the zod types in use is enough. |
| Keeping the six separate declarations with a test between them | Chosen against by the operator: one declaration, everything clean in one build. |

Prior art read for this design: the reverse-engineering write-up of Linear's sync engine
(load strategies per model, partial lists stored with a note of what was fetched, a batch
loader; whole records only, big text as its own record), Zero's documentation (whole rows,
query lifetime) and ElectricSQL's shape documentation.

## What must be measured

- Phone memory and cold start before and after, on the operator-sized data set and on the
  ten-times history set.
- First paint from an empty device, per client type.
- Main-thread time spent applying the feed and writing storage (the worker trigger).
- The cache cap that keeps memory within the phone's budget.
- The time to load a big tree (estimated at one to two seconds for 970 records, not measured).
- The existing server search at the ten-times history size.

## To settle during the build

- Whether an issue and its brief from the same save reach a device together, and whether any
  screen depends on that. They are separate log entries today.
- Whether a session's agent state is a saved field; a rule may not read a live value.
- What the sidebar shows on an empty device while its collection arrives: rows from the top down
  as a sorted range, or a loading state until complete.
- The collection of each record type, per the table above.

## Build tasks

Approved by the operator on 2026-11-17 and created, not started. They land on
`integrate/4286-data-on-device`. The four shared steps (1 to 4) are built in one go, not as a
quick first version followed by a clean one.

| # | Issue | Replaces |
|---|---|---|
| 1 | POD-7084 Shared record declaration | New |
| 2 | POD-7085 Collection fetch and policy | POD-5596, POD-6773, POD-6774 |
| 3 | POD-7086 Collections in the device store | POD-5595, POD-5598, POD-7048 |
| 4 | POD-7087 One loader for views | POD-5597, POD-5600 |
| 5 | POD-7088 Screens on collections | POD-5599 |
| 6 | POD-7089 Search surfaces use server search | The index and transcript search stay with POD-5617 |
| 7 | POD-7090 Generic live store | Covers the hot session values of POD-6811 |
| 8 | POD-7091 Declarative one-row builders | New |
| 9 | POD-7094 Remove all-history indexes | POD-5212; POD-5244 is answered by this design |
| 10 | POD-7095 Cache cap and phone memory | New |
| — | POD-7093 Explicit setup finished answer | New |

Order: 1, then 2, 3, 4 in sequence; 5 after 4 and POD-7093; 6 after 4; 7 and 8 after 1; 9
after 5; 10 after 9.

Out of this design: the per-record memory cost work (POD-5157, POD-5539, POD-5952, POD-5811)
and chat (POD-6671).

## History of this document

- First written from notes after the discussion, then corrected against the full conversation:
  a server search already existed; the stubs arrive last on an empty device; the days check is
  not a timer.
- A full review added the sidebar's sessions (which led to "comes with"), the record types per
  collection, per-record ordering of fetch against feed, and the offline answer. It withdrew
  the unique resume key.
- A test for simplicity merged "brings along" and "pulls" into "comes with", reduced the
  holders of an instance to the policy and open views, made the cache trim by instance,
  removed the client's network and storage facts, and reopened tree preloading.
