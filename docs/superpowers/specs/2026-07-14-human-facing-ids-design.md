# Human-facing IDs for issues and sessions + consistent linked display (#474)

## Goal

Every issue and session keeps its guaranteed-unique internal id (`iss_<uuid>`, session UUID) as the join key, and gains a presentable, stable, human-facing id used consistently across CLI, agent output, and every UI surface — and those refs are clickable everywhere.

## 1. Repo prefix

- New `repos.prefix` column: 2–5 uppercase ASCII letters, **unique across the server**.
- Derivation at repo add: first 3 letters of the repo name, uppercased (`podium → POD`). On collision: consonant-skip variant, then last-letter bump, until unique.
- Repo-add flow always **shows** the derived prefix and lets the user override it (validated: `^[A-Z]{2,5}$`, unique). The prompt is not collision-only — the user may always choose.
- Migration backfills prefixes for existing repos with the same derivation; collisions resolved deterministically; prefixes are editable later from the repos UI.
- Renaming a prefix is allowed (internal ids never change), but previously written refs stop resolving — the UI warns on change.

## 2. Issue nice id

- Format: `PREFIX-seq`, e.g. `POD-13`. The per-repo `seq` with `UNIQUE(repo_id, seq)` already exists — this is purely combinatorial.
- Server exposes `displayRef` on `IssueWire`.
- `resolveRef` (issues service core) gains a `^([A-Z]{2,5})-(\d+)$` branch so the CLI, mail, and agents can address issues as `POD-13`. Existing `#N` forms keep working.

## 3. Session nice name

- New persisted session fields: `ref_issue_id` (birth issue) and `ref_letter` (`A`…`Z`, then `AA`… — allocated per issue at naming time, never reused within an issue).
- Display: `POD-13-A`.
- Sessions with no issue at naming time get a per-repo draft counter: `POD-DRAFT-3`. (Most sessions attach to an auto-created draft issue, which already has a real seq — the DRAFT namespace is only for truly issueless sessions.)
- **Keep + alias** on re-attach: the birth name is permanent; when a session is attached to a different issue than its birth issue, the UI shows the current issue as secondary context ("working POD-27"). No rename ever.
- Sessions are resolvable by nice name in CLI and mail.

## 4. Canonical display formats

One shared formatter (web util + matching server-side formatter for agent-facing text). Exactly two forms:

- **short**: `POD-13` / `POD-13-A`
- **long**: `POD-13 · <title>` — title truncated at ~40 chars with ellipsis; full title revealed on hover (tooltip).

All existing inline `#${seq}` render sites (~15: sidebar, issue page, issue panel, context menu, approvals, page model, envelope labels) are refactored onto the formatter.

## 5. Agent instruction

Prime/hook text instructs agents to always reference issues and sessions as nice id + name (`POD-13 (Fix session naming)`). Server-rendered principals/envelopes use the same format.

## 6. Clickable refs — everywhere, including the terminal

- **Markdown surfaces** (ChatView, SuperagentView, issue notes): a linkify pass in the markdown pipeline (analogous to the existing file-path linkification) turns `PREFIX-N` and `PREFIX-N-LETTER` tokens into ref anchors.
- **Native terminal view**: an xterm.js `registerLinkProvider` matching the same token grammar on visible rows — same mechanism as URL links, no output parsing. In scope for v1 (explicit decision: no deferring).
- Only tokens whose prefix matches a registered repo prefix are linkified (avoids false positives like `UTF-8`).

## 7. Click semantics (uniform)

- **Plain click** → floating miniview: a net-new draggable fixed-position card (drag by header), rendering compact issue-panel or session-summary content, with actions: close, and open-full (closes the miniview and navigates to the full issue/session view).
- **Cmd-click (mac) / Ctrl-click (other)** → navigate directly to the full view (standard browser/IDE modifier convention).

## Error handling

- Ref resolution failures (unknown prefix, dead seq, retired session name) render as plain text in linkify passes and return a clear CLI error.
- Prefix uniqueness enforced at DB level; concurrent repo adds race-safe via the unique index.
- Letter allocation is transactional per issue (no duplicate `POD-13-A`).

## Testing

- Unit: prefix derivation/collision fallback, ref grammar parse/format round-trip, letter allocation (incl. Z→AA), resolveRef new branch, formatter truncation.
- Migration test: backfill on a fixture with colliding repo names.
- Web: formatter component tests; linkify pass tests; Playwright real-click check of miniview open/drag/open-full and Cmd-click navigation in chat and terminal (per repo rule: interactive UI needs runtime verification).

## Out of scope

- Retro-resolving refs written before a prefix rename.
- Multiple simultaneous miniviews (v1: one at a time).
