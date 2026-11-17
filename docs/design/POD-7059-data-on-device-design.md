# Data on the device (POD-7059)

Status: design discussed with the operator on 2026-11-17. Design only; nothing is built.
Two points are proposed and not yet confirmed; they are marked **proposed** and listed in
[Open points](#open-points). The document was written after the discussion and then checked
against the full conversation; [What the check changed](#what-the-check-changed) lists the
corrections.

This design answers one question for the start-up phase (POD-5910) and the memory phase
(POD-5211): which data is on the device and in memory at any moment, how it gets there, and how
it leaves.

## Summary

1. The device holds **collections**, not "everything". A collection is a declared rule over a
   record's own fields. The device knows for each collection it holds that it is complete.
2. Every issue is on the device at least as a **stub**: reference, state and parent. Counts and
   links work from stubs, for all history, without the full records.
3. The **server decides** which collections a client loads at start, per client type (phone,
   browser, desktop). The client reports facts and follows the policy.
4. There is **one loader and one fetch route**. The first download is the first batch of
   fetches, in a fixed order. Everything later uses the same route.
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
| Collection instance | A collection with its arguments filled in: "the tree under issue X". Definitions are few; instances are many. |
| Marker | The note "this collection instance is complete as of feed number N". |
| Policy | Server data per client type: which collections load at start, in which order, and the numbers (days, tree size, cache cap). |
| Bring-along | A kept record brings the records it points to: a session brings its issue, an issue brings its parents and its small companions (the user's read state, its dependencies). Upward only, never down to children. |

## The design

### One shared declaration

Each record type is declared once in `@podium/model` with a small `defineRecord` helper on top
of the zod types that already exist. No new schema framework.

The declaration holds:

- the fields and which part each belongs to;
- the relations to other record types;
- what a kept record brings along;
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
Builders for kinds that are one database row become declarative.

### Parts

| Part | Content | Loaded |
|---|---|---|
| Stub | Reference, state, parent (issues only) | For every issue, at start, last in the order |
| Main | The other slim fields: title, priority, dates, links | With the collections in the policy, or when a view asks |
| Body | Brief and description | When the issue is opened |
| Live | Values that change every second: busy, last input, context use, terminal size | While something watches them; never stored |

Per record the device holds exactly one row. It is a stub or it has more parts. Loading the main
part fills the row; trimming removes parts again and never needs a fetch. Stub and main are the
same wire record, so state and parent have one home and can never disagree.

The stub needs no builder on the server: it is the declared stub fields picked from the built
record. The feed needs no stub kind. The only new thing on the wire is that the first download
and the fetch route can send an issue at stub level.

The body stays what it is today, separate records for brief and description, so that a small
change to an issue does not send two kilobytes of text again.

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
The guard is that the stubs are a collection like any other, so the policy can cap them per
client type, and links and chips already fall back to a batched load.

Sessions have **no stub**. The questions that seemed to need one do not
(see [Where each question gets its answer](#where-each-question-gets-its-answer)).

The live part replaces the hand-written live store: one generic store built from the
declaration, one map per declared live part, held only while watched. This design covers the
hot session values directly and does not wait for POD-6811. Live readings that belong to no
record (connection, quota, unsent writes) stay as they are.

Only issues and sessions have more than one part. The other 31 record types are a single part.

Not checked: whether changes to two parts of one record from the same save always reach a
device together. Stub and main are one record, so they do. An issue and its brief are separate
log entries today.

### Collections

| Collection | Loaded by |
|---|---|
| Always: small kinds every screen needs (repositories, machines, settings, labels) | Policy, first |
| Live: live sessions, sessions that ask for the user, pinned records | Policy, first |
| Recent: issues and sessions changed in the last N days | Policy |
| Sidebar: open issues that are not proposed | Pinned by the worklist, which is always on |
| Issue stubs: every issue | Policy, last |
| Tree: all issues under one top-level issue | Policy for trees up to 50 issues; otherwise the view that opens it |
| Page: one page of a sorted list, for example a board column or the proposal deck | The view that shows it |
| Sessions of one issue | The issue page |
| One record by ID | A lookup that finds the record absent |

"Recent" reads a time saved on the record: an issue's last-change time, and for a session the
coarse activity time its record carries. It does not read the live "last active" value.

Three things can hold a collection instance on the device: the policy, an always-on view (a
pinned list), or an open view. An instance held by none of them is cache. A pinned list is
never trimmed.

Definitions are few, perhaps fifteen to twenty. Instances are many, one per thing the user
opened, and each costs one small marker. The cost of applying a change depends on the number of
definitions, not instances: one lookup per definition ("do I hold the children of this issue's
parent?").

The client's reader index already files each record into named buckets from its own fields (by
repository, stage, open or closed, proposed, live, issue). Those buckets are collection rules
already; they stay and only cover the rows in memory.

The sidebar collection holds all open issues that are not proposed, as the operator expects to
see everything left there. It grows with open work, not with history. The operator decided to
leave it uncapped until it becomes a problem; the cap is a policy number when needed.

A sorted, paged collection keeps a range marker: "complete from the top down to this position".

### Policy

The server holds one policy per client type. The client sends facts (its type, metered network,
free storage) and receives the policy in the load header. The client never chooses sets itself.

Starting numbers:

| Client | Recent | Whole trees preloaded | Extra |
|---|---|---|---|
| Phone | 7 days | Up to 50 issues | |
| Browser | 30 days | Up to 50 issues | |
| Desktop | 30 days | Up to 50 issues | Big trees that have live work |

On the operator's data the phone policy holds about 1,900 full issues (1,858 by their own
fields, the rest brought along as parents) instead of 8,687. Trees up to 50 issues cover 620 of
635 trees and add 643 issues. The 15 bigger trees hold 3,271 issues and load when opened.

What the server-side policy gives:

- Numbers change without a client release. A phone app takes days to ship.
- A hosted server can cap what any client loads, and tune it per workspace.
- "Keep more on this device" is a server-side setting that follows the user to a new device.

When the policy for a client changes, the client fetches the difference or lets the surplus
become cache.

The server does not stamp records with their set. The rule reads the record's own fields and the
date, so the client can decide by itself what a change means.

### One loader, one route

The client has one loader. Its input is a list of collection instances; its output is whole
records in feed format plus a marker per instance. It collects requests for 50 ms, removes
duplicates, and fetches what the answer brings along.

The server has one generic fetch route beside the existing `/sync/bootstrap` and `/sync/delta`
stream routes. It is not tRPC with an endpoint per screen and not GraphQL: the question is
always a collection instance, and the answer is always whole parts of records.

The first download is the first batch, in this order:

1. Always and live. The first screen can paint.
2. The collections the visible view asks for.
3. Recent.
4. Sidebar.
5. Small trees.
6. On the desktop, big trees with live work.
7. Issue stubs.

Each collection is installed in chunks and its marker is written last. A download that is
interrupted resumes at the first collection without a marker. This replaces the single large
install that loses everything when the app closes early (POD-7048).

Later starts read the disk and ask the feed for the changes since the stored feed number.
Nothing else is fetched.

If the feed cannot bridge the gap (the device was offline for longer than the server keeps its
log), the markers are dropped and the collections load again. During that reload the old rows
stay on screen and are replaced as fresh ones arrive; counts show loading until their
collection is complete again. This is the "show what is stored, refresh, repaint" behaviour the
operator asked for, without a fourth lookup state.

### The feed

The feed is unchanged on the server: it delivers every change the user may see, as whole slim
records. The client decides per change:

| The device holds | What the client does |
|---|---|
| The record with its main part | Replaces it |
| The issue as a stub, and the change does not match a held collection | Updates the stub fields |
| The issue as a stub or not at all, and the change now matches a held collection (an old issue is reopened) | Keeps the full record and fetches what it brings along |
| Nothing, and no held collection matches | Ignores it |

A deletion or a loss of visibility gives the lookup answer "gone". Because the feed is applied
without gaps, a collection that was complete stays complete.

### Lookup

Looking up a record keeps its three answers: here, on its way, or gone. There is no fourth
"may be outdated" state. A stub is "here" for a reader that asks only for stub fields and "on
its way" for a reader that asks for more; the loader then fetches the missing part.

### Memory and leaving

Everything on the device is also in memory. The cache cap is therefore the memory cap.

- Storage reads stay synchronous, from memory.
- Indexes cover only rows in memory, which now means the rows on the device. The index over all
  history, its relation index and the active-work rule are deleted.
- A record leaves a collection when it stops matching (an issue closes, the days pass). It is
  then cache. Nothing moves it: a view that lists "recent" filters by the clock as it reads, and
  the trim checks membership at that moment.
- When the cache is above its cap, the records read longest ago that are in no held collection
  are trimmed: issues back to their stub, other records removed. This trim is the only sweep.
  It does not have to be prompt, because holding extra records never makes a list wrong.

**One copy in memory.** The earlier memory work in this epic found that row copies were never
the cost: a row is about 550 bytes, and the storage copy, the sync engine's lists and the data
layer all point at the same row objects (POD-5133). The cost was the indexes over history. So
"one copy" is reached by removing history from the device, not by changing who owns the rows.

Estimates for this design, not measured, using that work's figure of 1 to 5 KB per record held
with its indexes:

| | Phone | Desktop |
|---|---|---|
| Policy collections | about 3,000 records, 5 to 10 MB | about 5,000 records, 10 to 20 MB |
| Cache | a small cap, a few MB | 5,000 to 10,000 records, 10 to 40 MB |
| Stubs | 1 to 2 MB | 1 to 2 MB |
| Today, for comparison | 65 to 80 MB on the phone fixture | about 90 MiB |

The four rules pinned on the earlier memory work stay in force (POD-5212): rows are read
through one reader; indexes cover only rows in memory; a record not in memory is described by a
small declared summary, which is now the stub; an absent row answers "on its way" and starts a
batched load.

The operator agreed to this with "unsure but yes". The design keeps the way back open:

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

- Counts by stage, child counts and tree progress come from the stubs. They are exact, local and
  cover all history.
- A count under a filter that the stub cannot answer (priority, project) arrives with the first
  page of that list, counted for that viewer. While the view is open and a change arrives that
  could move it, the client asks again. The server already has a count by stage, priority, type
  and assignee (`issues` service, `count`).
- On an empty device the stubs arrive last. Until they are complete, a count over all history
  shows loading. A view that needs the numbers first can ask for its tree at stub level, which
  is small.
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

## Two examples from an empty device

**A small tree (12 issues).** Always and live arrive and the first screen paints. Recent and the
sidebar follow. The tree is under 50 issues, so the policy loads it whole. Opening its flight
deck shows everything at once, from memory, with exact progress.

**A big tree (970 issues, 922 closed), opened straight after install.** Always and live arrive;
the members with running sessions are in the live collection, so the deck's working and
needs-you rows paint with the first screen. The deck is the visible view, so its tree goes to
the front of the queue: first at stub level, which gives "922 of 970", then the full records,
which fill in the phases and done members as they arrive. The rest of the first download
continues behind it. After that the tree stays on the device and the feed keeps it current.
On the desktop the policy loads this tree in the background anyway, because it has live work.

**The second start, for both.** Everything comes from disk, with no fetch and no loading rows.
The feed delivers what changed while the app was closed.

## Where each question gets its answer

Every question that today reads all history was traced to the feature that asks it. None of
them needs all issues or all sessions. The survey was done per kind of question (about 45 query
methods in about 35 files); not every call site was read.

| Feature | What it needs | Answer |
|---|---|---|
| Sidebar | Open issues that are not proposed | Sidebar collection |
| Flight deck, issue page | Members of one tree, links, sessions of the issue | Tree collection, sessions-of-issue collection |
| Progress bars and child counts | Parent and state of every member | Stubs |
| Links and chips in chat and terminal | Reference and state | Stubs; absent record loads in a batch |
| Header, explorer, shell | Live and recent sessions | Live and recent collections |
| Board columns | Issues of one stage, sorted | A collection per stage: what the device holds shows at once, the rest (proposed, done) arrives by page and is then kept |
| Which issue owns this folder (header, shell) | Open issues with a worktree | Sidebar collection |
| References to sessions in chat and terminal | The session's status | The session if held; otherwise a batched load. Old session references are not coloured until loaded, because sessions have no stub |
| Board counts by stage | Stage of every issue | Stubs |
| Board counts under a priority or project filter | A filtered total | Arrives with the page |
| Board filter menu | The possible assignees, labels, projects | Their own records, not a walk over every issue |
| Command palette | Recents; matches for typed text | Device, then server search (works this way today) |
| Mention in chat | The five best matches | Device, then server search |
| Phone "link to task" picker | Matches in one repository; "is there any other task" | Device, then server search; stubs |
| Position of a new task | The current top of the list | The sidebar collection |
| Proposal screening on the phone | The next cards and a count | Page collection; count from stubs |
| Phone inbox and sessions screens | — | No longer reachable; the code is deleted |
| First-run setup screen | Whether setup is finished | **Proposed:** an explicit server answer, see below |
| Default agent in setup | The agent of the latest session | The latest session on the device, else the default |
| Workflow or automation run pointing at a session | That one session | An ordinary lookup |
| "Sessions: N" in phone settings | A diagnostic | The number on the device |
| Hiding duplicate sessions (resume twins) | — | **Proposed:** fixed on the server, see below |

## What is deleted

- The memory copy of all history and the start-up load of every record, including the brief of
  every issue (20 MB today).
- The index over all rows with its relation index (`cold-index.ts`), and the summaries that
  describe rows not in memory.
- The active-work rule (`packages/model/src/predicates/active-work.ts`); the policy and the
  collections replace it.
- The client rule that hides duplicate sessions, once the server fix is in.
- The phone's inbox and sessions screens with their readers.
- The hand-written kind lists and the hand-written live store.

There are no compatibility paths for old clients. The wire version changes once, on the
integration branch.

## Approaches considered

| Approach | Why not |
|---|---|
| One rule sized for the smallest device | Rejected by the operator as limiting. The server policy per client type replaces it. |
| The client picks its own sets | A dumber client is easier to change; the server holds the policy. |
| The server stamps each record with its set | Not adopted; the operator was unsure. The rule reads the record's own fields, so no stamp is needed. |
| Query-driven sync like Zero (any query, cached for minutes) | Needs per-client query state on the server. Views pinning declared collections gives the useful part without it. |
| Count records kept by the server | A shared count can include records a viewer may not see. |
| Load every sub-issue of every kept tree and count locally | Exact, but 58% of all issues on the operator's data, driven by a few long-running trees. Kept for trees up to 50 issues and for trees the user opens. |
| A "may be outdated" fourth lookup state for cached records | The feed keeps cached records current, so every screen handles three answers, not four. |
| A title index on every device for offline search | Grows with history. It stays possible later as one more part. |
| GraphQL for the fetch route | Its strength is per-screen field selection, which this design avoids on purpose. |
| Adopting a sync product (Zero, ElectricSQL, PowerSync, TanStack DB) | Each replaces the sync log, the store or the model layer that exist, and none runs on both SQLite and Postgres. |
| A schema framework (Effect Schema, TypeSpec, a move to zod 4) | A thin `defineRecord` on the zod types in use is enough. |
| Keeping the six separate declarations with a test between them | Chosen against by the operator: one declaration, everything clean in one build. |
| A separate stub record type | Two homes for state and parent can disagree. The stub is a part of the issue record. |
| Arbitrary column subsets per collection (as ElectricSQL allows) | Fixed parts keep "one row per record, each field in one part". |
| Memory holds only what open views read | Indexes would be rebuilt on every navigation; the earlier memory work warns against that (one rename read 3,798 rows without incremental indexes). |
| Policy collections in memory, the cache on disk only | Kept possible behind the loader. Not chosen now: it makes the storage interface asynchronous for no visible gain at these sizes. |
| The sync engine in a worker | Deferred until measured. |

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

## Open points

1. **Proposed: unique resume key.** Two session records can point at the same agent
   conversation, because the database has no unique key for it. The operator's data has 10 such
   pairs among 5,376 resumable sessions, all created between June and August 2026. The fix is a
   unique key on the server (headless sessions excluded, they share the key on purpose) and a
   merge of the old pairs. It is a server task of its own.
2. **Proposed: explicit "setup finished".** The setup screen starts when there are no
   repositories and no sessions, and uses the session count to detect a stale local flag. The
   server should answer "setup is finished" next to the answer it already gives for "this person
   sets up the server". It is a server task of its own.
3. **Default taken, not discussed:** the body part loads when an issue is opened. The policy can
   preload bodies for issues with live work if opening them proves slow.
4. **To check during the build:** whether an issue and its brief from the same save reach a
   device together, and whether any screen depends on that.

## Build tasks

Approved by the operator on 2026-11-17 and created, not started. The old tasks named in the
tables are superseded and still open; the coordinator retires them.

| # | Issue |
|---|---|
| 1 | POD-7084 Shared record declaration |
| 2 | POD-7085 Collection fetch and policy |
| 3 | POD-7086 Collections in the device store |
| 4 | POD-7087 One loader for views |
| 5 | POD-7088 Screens on collections |
| 6 | POD-7089 Search surfaces use server search |
| 7 | POD-7090 Generic live store |
| 8 | POD-7091 Declarative one-row builders |
| 9 | POD-7094 Remove all-history indexes |
| 10 | POD-7095 Cache cap and phone memory |
| Server | POD-7092 Unique session resume key |
| Server | POD-7093 Explicit setup finished answer |

Order: 1, then 2, 3, 4 in sequence; 5 after 4 and the two server tasks; 6 after 4; 7 and 8
after 1; 9 after 5; 10 after 9.

Under the start-up phase (POD-5910):

| # | Task | Replaces or changes |
|---|---|---|
| 1 | Shared record declaration: fields, parts, relations, bring-along, collections; generated wire and type lists | New |
| 2 | Server: fetch route for collection instances, stub part, policy per client type, ordered first download | POD-5596; POD-6773 becomes "policy" instead of load classes; POD-6774 becomes this fetch route |
| 3 | Client store: collection instances with markers, chunked resumable install, feed applied to what is held | POD-5595, POD-5598, POD-7048 |
| 4 | Client loader: one loader, lookup with parts, pinned and opened lists, bring-along | POD-5597, POD-5600 |
| 5 | Screens: move each reader per the table above; counts with the page; delete the phone inbox code | POD-5599; POD-5915 (records that arrive by request) is to be checked against the loader |
| 6 | Mentions, pickers and the board text filter use the existing server search after device results; measure it at scale | The index and transcript search stay with POD-5617 |
| 7 | Generic live store from the declaration | Covers the hot session values of POD-6811 |
| 8 | Declarative builders for one-row kinds | New |

Under the memory phase (POD-5211):

| # | Task | Replaces or changes |
|---|---|---|
| 9 | Delete the all-history index, its relation index and the active-work rule; indexes over rows in memory only | POD-5212; POD-5244 is answered by this design |
| 10 | Cache cap and trim to stub; phone memory measured before and after | New |

Separate server tasks: the unique resume key and the explicit "setup finished" answer (open
points 1 and 2).

Unchanged and out of this design: the per-record memory cost work (POD-5157, POD-5539,
POD-5952, POD-5811) and chat (POD-6671).

## What the check changed

The first version of this document was written from notes. Reading the full conversation back
corrected it in these places:

- A server search over issue titles, descriptions and briefs already exists. An earlier turn of
  the discussion said none existed; that was wrong. Task 6 shrank accordingly.
- On an empty device the stubs arrive last, so counts are not available "at once". The example
  and the counts section now say so.
- The check for "the days passed" is not a timer. It happens when a view reads and when the
  cache is trimmed, as discussed.
- Added what was discussed but missing: the companions a record brings along, the saved time
  that "recent" reads for sessions, the behaviour after a long time offline, the benefits of a
  server-side policy, the cost of many collection instances, the memory estimates, what "one
  copy in memory" means after the earlier memory work, and seven rejected approaches.
- Stated what is lost without a session stub: old session references are not coloured until
  loaded.

