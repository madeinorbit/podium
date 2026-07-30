# Salvage assessment: `salvage/mobile-wip-from-293` (5370e72f)

## Verdict

**Do not land the salvage branch as-is.** It does not repair `/mobile` on main, and it does not build.

## What the salvage contains

Uncommitted, half-merged mobile navigation WIP from the POD-293 worktree:

| Change | Notes |
| --- | --- |
| Tabs: Work/Chat vs Work/Super Agent | Conflict markers in `_layout.tsx` and `TabBar.tsx` |
| `IssueBrowserScreen` + `issue-browser.ts` | Nested session rows under issues (good idea) |
| Delete `SessionsScreen` | Already unused on main after POD-241 |
| Superagent composer padding | Minor |
| `IssuesScreen` sticky header padding | Conflict markers |

Conflict markers remain in three tracked files:

- `apps/mobile/app/(tabs)/_layout.tsx`
- `apps/mobile/src/components/TabBar.tsx`
- `apps/mobile/src/screens/IssuesScreen.tsx`

## Relationship to main

POD-241 / POD-259 already landed the intended navigation shape on main:

- `a462a2a7` Wire mobile Work tab
- `d05010fa` Restore mobile issue-first routing (`WorkScreen` + `work-sections`)
- `1a607005` Restore mobile workspace navigation (Super Agent tab)

Main already has Tray / Work / Tasks / Super Agent. The salvage is an alternate unfinished path (IssueBrowser + Chat rename), not a missing merge of that work.

## Actual `/mobile` breakage on this host

Live probe before fix:

```text
GET /mobile → 302 Location: /
```

Cause: `apps/mobile/dist` was **empty** (gitignored export). `registerMobileRouting` correctly falls back to `/` when the Expo build is absent. `podium-web.service` (the unit that rebuilds web + mobile dist) was **not installed** on this host; the template also hard-coded `/home/user/src/other/podium`.

Main source typechecks and `bun run --filter @podium/mobile build:web` succeeds. Rebuilding dist restores HTTP 200 + the Expo login shell.

## What we took from the salvage

Nested agent rows under each issue (desktop sidebar / taskbar parity), plus pin band, `sortKey` order, and tuck-away for finished work — implemented cleanly on main's `WorkScreen` / `work-sections` path (no conflict markers, no chat-tab rename).

## Not taken

- Renaming Super Agent → Chat / dropping the superagent route file
- Replacing WorkScreen with IssueBrowserScreen as a parallel module
- Deleting SessionsScreen (orphan cleanup can be a follow-up)
