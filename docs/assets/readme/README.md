# README product images

These images show the illustrative Kelvra project that the Podium website also uses, refreshed on
2026-11-06 for the 0.3 interface. Kelvra is fictional. The images may show development UI, not a
guarantee of feature availability in the latest stable release. This file records where each one
came from.

| Local file | Source |
| --- | --- |
| `team-view.png` | Unchanged copy of the website's `marketing/captures/compare-blockers.png` |
| `coordinator-chat.png` | Unchanged copy of the website's `marketing/captures/compare-chat.png` |
| `agent-offer.png` | Unchanged copy of the website's `marketing/captures/compare-offer.png` |
| `proposed-task.png` | Unchanged copy of https://podium.do/marketing/captures/proposals.png |
| `task-board.png` | Real `IssuesView` rendered at 1522 × 520, scale 2, from a throwaway copy of `apps/web/harness/issue-board.browser.tsx` seeded with Kelvra tasks. The harness toolbar buttons are hidden. |

The first three are rendered from the website's HTML port of the app, not captured from a running
instance. `proposed-task.png` is a capture from an isolated instance.

Store replacements here so GitHub and cloned copies do not depend on the website's asset URLs.
Prefer readable task and conversation views that demonstrate the same project.

## Composed images

- `../readme-hero.jpg`: the website's hero story (`apps/site/src/components/hero-story`) rendered
  with its `shell` prop for the full desktop window, 1320 × 780 at scale 2 with reduced motion. The
  website's "Your call. Land it." hint is hidden, task refs in the list are changed so they match
  the board, one list title is changed to "Launch week changelog", and the status strip says one
  agent is working. It sits on the site's `apps/site/src/assets/hero/painting.jpg` with window
  controls added.
- `task-board-framed.png`: `task-board.png` on the same painting. This replaces the earlier
  AI-assisted composition.

`distribution/SUBMISSIONS.md` names `readme-hero.jpg` and `task-board-framed.png`, so keep those
filenames when replacing them.
