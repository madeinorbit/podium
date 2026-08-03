# Live-database upgrade rehearsal — 2026-08-03

Integration `4045b2d2`. A copy of the real installation, upgraded by the rewrite.

## Method

The live database was never touched. A consistent snapshot was taken through a
READ-ONLY handle (`VACUUM INTO`), and the whole state directory was copied —
`config.json`, `instance.json`, `auth.json`, `daemon.secret`, `repos.json`, and
both databases. The live file's size and mtime were checked before and after.

The first attempt copied only `podium.db` and the app showed the FIRST-RUN WIZARD.
That was the rehearsal being unfaithful, not a defect: setup state lives in
`config.json` (`mode: "server"`). Recorded because it is the exact mistake an
upgrade runbook would make.

Corpus: **205 MB — 1569 issues, 1171 sessions, 5406 messages, 13 repos.**

## Results

**Migrations applied cleanly.** 21 new on top of the 30 already present, 51 total.
The runner wrote a pre-migration backup of its own accord
(`podium.db.backup-vdrizzle-30-…`) — worth keeping.

**No data was lost.** Row counts, live vs migrated:

| table | live | migrated | |
|---|---|---|---|
| issues | 1569 | 1569 | ok |
| sessions | 1171 | 1171 | ok |
| repos | 13 | 13 | ok |
| machines | 3 | 3 | ok |
| issue_deps | 1213 | 1213 | ok |
| issue_comments | 2555 | 2555 | ok |
| messages | 5406 | 5434 | live kept receiving mail after the snapshot |

**The install was recognised as existing.** No setup wizard. The app renders its
sign-in screen and asks for the password — correct behaviour for an upgraded
install with real data behind it.

**POD-1554's credential migration executed on real data.** `user:sole` now holds
`source = per-user-scrypt` with a real hash, and `auth.json` is GONE — the
verify-then-clear contract, observed rather than asserted.

**Zero console errors** in the browser throughout.

## The finding

**First boot took ~530 seconds (~9 minutes)** before the port opened. Migrations
finish early; the rest is unexplained post-migration work. Not a hang — measured
mid-boot at 81% CPU, 684 jiffies per 8s sample, RSS 786 MB.

On a real upgrade that is a nine-minute outage with no page and no explanation.
An empty-database boot takes seconds, so only a rehearsal on real data reveals it.
Filed as **POD-1597**, with the decisive question called out: is it per-boot or
once? Measure a SECOND boot of the same already-migrated directory.

## Not verified here

Logged-in behaviour. The upgraded instance correctly demands the operator's
password, which I do not have. It is running at `http://ludovico:18902` for a
human to carry on from.
