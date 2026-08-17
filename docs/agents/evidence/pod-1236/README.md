# POD-1236 — the browsed repo is offerable

Standing inside a folder that IS a git repo, the repo picker had no way to add it:
the per-entry "Use repository" buttons all belong to SUBfolders, and the typed-path
row at the bottom starts empty, so its button is disabled. The one folder you had
already chosen was the one you could not pick.

`RepoPickerModal` now offers `listing.path` as the field's placeholder whenever the
browsed folder is a repo; the button acts on that offer, typing takes over, and
clearing hands it back.

## Evidence

Driven through the real `RepoPickerModal` in a browser (a throwaway vite harness
stubbing only `@/app/store`, whose one read is `s.trpc`), against `styles.css` as it
ships. No page errors, console errors, or failed requests.

| state | placeholder | field | heading | button |
| --- | --- | --- | --- | --- |
| parent folder, not a repo | `/home/user/project` | empty | Or use a repository path | disabled |
| inside the repo | `/Users/till/meridian-web` | empty | Use this folder, or another path | **enabled** |
| typed a path | `/Users/till/meridian-web` | `/Users/till/other-project` | Use this folder, or another path | enabled |
| cleared again | `/Users/till/meridian-web` | empty | Use this folder, or another path | enabled |

Clicking the button in the last state called `onPick('/Users/till/meridian-web')` —
the offered path, not an empty string.

- `1-not-a-repo.png` — unchanged behaviour where nothing is offered
- `2-inside-a-repo.png` — the reported case, now addable
- `3-typed-path.png` — a typed path overriding the offer

The unit test in `RepoScanFlow.machine.test.tsx` was validated against a planted
regression (`browsedRepoPath` forced to `null`): it fails there and passes here.
