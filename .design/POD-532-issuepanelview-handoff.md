# POD-532 handoff — IssuePanelView RecentActivity

The `subject` filter is landed end-to-end (contract → registry → service → SQL, plus an
index). `IssuePanelView.tsx` is the last caller still paging the repo-wide log and
filtering in the browser. It is owned by the workspace rework, so this is the exact
change to apply there rather than a commit.

**File:** `apps/web/src/features/issues/IssuePanelView.tsx`
**Location:** the `RecentActivity` events effect (was lines 197–223 at
`a9a7047b8` + the rework's in-flight edits — anchor on the text, not the numbers).

## Replace this

```tsx
  // `issues.events` has no per-subject filter yet, so this is the whole repo's
  // log filtered down to one issue — the same shape the issue page uses. It is
  // deliberately NOT keyed on `issue.updatedAt`: a supervised issue mutates
  // constantly, and refetching the entire log on every agent state write would
  // make the dock the most expensive surface in the app. The subject filter
  // POD-532 is adding to the procedure is the real fix; when it lands, this
  // query grows a `subject` argument, the `.filter(...)` below goes away and
  // the effect keys on `issue.updatedAt` like the comment fetch above.
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => trpc.issues.events.query({ since: 0, repoPath: issue.repoPath, limit: 1000 }))
      .then((rows) => {
        if (!cancelled)
          setEvents(
            rows
              .filter((row) => row.subject === issue.id)
              .map((row) => ({ ...row, payload: row.payload ?? null })),
          )
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.repoPath, trpc])
```

## With this

```tsx
  // Narrowed to THIS issue on the server (POD-532: `subject` filters in SQL, on
  // `idx_podium_events_subject`), so the dock reads one issue's events instead of
  // paging the repo-wide log and filtering here. That is what makes keying on
  // `issue.updatedAt` affordable — the feed now tracks a supervised issue live
  // instead of going stale until the panel is reopened.
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() =>
        trpc.issues.events.query({
          since: 0,
          repoPath: issue.repoPath,
          subject: issue.id,
          limit: 200,
        }),
      )
      .then((rows) => {
        if (!cancelled) setEvents(rows.map((row) => ({ ...row, payload: row.payload ?? null })))
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [issue.id, issue.repoPath, issue.updatedAt, trpc])
```

## The three changes, stated plainly

1. **Query shape** — add `subject: issue.id`; drop `limit: 1000` to `limit: 200`
   (`ISSUE_EVENTS_DEFAULT_LIMIT`; one issue's whole history is far under it, and the
   dock only renders the last 5 anyway).
2. **Client-side filter** — delete `.filter((row) => row.subject === issue.id)`. The
   server no longer returns anything else. Keep the `payload ?? null` map.
3. **Refetch key** — add `issue.updatedAt` to the dep array. This is the point of the
   whole issue: the old comment said the dock *deliberately* would not key on it
   because the query was too expensive. It no longer is.

## If a test mocks `issues.events`

Make the fake honour `subject` the way SQL does, so a page that forgets to send it
still fails:

```ts
const eventsQuery = vi.fn(async (input?: unknown) => {
  const subject = (input as { subject?: string } | undefined)?.subject
  return subject ? ROWS.filter((r) => r.subject === subject) : ROWS
})
```

That is exactly what `IssuePage.activity.test.tsx` now does.
