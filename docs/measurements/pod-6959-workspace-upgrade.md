# POD-6959: the workspace upgrade, measured (M1 and M2 together)

Task POD-7025, for the design's section 2.6 ("Measured duration"). Measured on 2026-11-17.

## Result

An existing install upgrading to the workspace data model runs the workspace column migration
(M1, `20261117050304_workspace-column`) and the keys migration (M2,
`20261117104939_workspace-keys`) in one boot, with the three migrations between them
(`workspace-meta-split`, `artifact-uploads`, `pending-uploads`). On a synthetic database the
size of the reference database, that whole upgrade took **21.7 to 25.6 seconds**, of which the
pre-migration backup took **6.6 to 6.7 seconds**.

| Run | Host load (1-minute average) at start | Total | Backup | Migrations (M1 through M2) | Against the 5-minute expectation |
|---|---|---|---|---|---|
| 1 | 1.96 | 25.6 s | 6.6 s | 19.0 s | 8.5 % of 5 minutes: well under |
| 2 | 3.66 | 22.7 s | 6.7 s | 15.9 s | 7.6 % of 5 minutes: well under |
| 3 | 3.89 | 21.7 s | 6.7 s | 15.0 s | 7.2 % of 5 minutes: well under |

The design expected under 5 minutes for M1 and M2 together on the reference database at normal
load (host load below 10). This is a measurement to report, not a pass or fail gate. All three
runs were at a load below 4, and each took less than a tenth of the expectation.

In every run all five migrations applied, and every table kept its row count across the
upgrade, except `meta` (the workspace-meta split moves the workspace's keys to `workspace_meta`)
and `feed_identity` (the legacy feed singleton, which the keys migration drops; design 2.1).

## How it was measured

The script is `scripts/server-data-bench/workspace-upgrade.ts`.

1. **The reference database's shape.** The newest update backup in the operator's state
   directory (the reference database: a 3.58 GB file of 875,056 pages of 4 KB, 406,951 of them
   free, so about 1.92 GB in use) was opened in place with `mode=ro&immutable=1`. The script read
   only each table's row count and its `dbstat` size, the page and free-page counts, and the size
   of the full-text search tables. Nothing was copied and nothing was written there; the file's
   size and modification time were the same afterwards. The profile holds counts and sizes
   only (795,151 rows in 125 tables), no row content.
2. **The synthetic database**, built on the second test host in a temporary directory that is
   removed after each run. The migration chain ran up to the migration before M1. Then every
   table got the reference's row count, its rows padded to the table's average size. Rows follow
   the fixture rule of `migrations/workspace-keys.test.ts`: row n holds `v<n>` in its key and
   unique columns, and the values of that test's rows 1 and 2 elsewhere, so every CHECK holds.
   The search tables, which boot makes and the upgrade does not rebuild, are stood in by one
   filler table of their size (105 MB). The reference's free pages come from a filler that is
   then dropped. The result is a 3.79 GB file with about 2.1 GB in use, about 1.1 times the
   reference's used bytes. Two tables of the reference have no counterpart in the chain and were
   left out: `messages_backup_20260811_janitor` (229 rows, 340 KB) and `schema_version` (28 rows,
   4 KB).
3. **The upgrade, as a boot runs it**: foreign keys off around the migrator, which takes the
   free-space preflight and the full pre-migration backup and then applies every pending
   migration through M2 in one transaction. The backup's time is read from the `backup` boot
   stage the migrator logs. "Migrations" is the total less the backup.

The second test host has 8 CPUs and 23 GB of memory, shared with other work, and runs Bun 1.4.4.
Each run held the host's test lock, and the load was read just before the upgrade started.
Building the synthetic database took 32 to 36 seconds per run and is not part of the times
above.

## Compared with the keys migration's own measurement

POD-7024 measured the keys migration alone at 47.5 s, with a 9.7 s backup, on a 5.02 GB
synthetic database. That database stood at 1.4 times the reference's used bytes: its rows were
padded to the table plus index size. This one pads to each table's own b-tree size, which comes
to 1.1 times, closer to the reference. On less data the rebuilds take less time, so the two
measurements agree that the upgrade is well inside the expectation. The design's own estimate,
about 3 minutes, was a rebuild of every table of the reference at that time.
