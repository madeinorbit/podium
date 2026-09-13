# RUNBOOK — put the tracker database back to ledger 98

**You will be alone while you do this.** Podium is how you reach your assistant,
and step 1 stops Podium. Everything below is written to be done with no help,
using one program you already have (`sqlite3`). Read it all once before starting.

Nothing here needs the network, `podium`, `bun` or `node`.

---

## What is wrong, in one paragraph

Nine unreleased migrations ran against your live tracker and moved it from
schema version ("ledger") 98 to 107. Your installed Podium server predates all
nine — it has never heard of them. Two things follow. It cannot open the
database at all, because a server refuses a database newer than itself. And
while it has been retrying, it has been writing rows that name the user
`user:sole`, into a database that migration 99 renamed to
`mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8`. So the database is **split-brained** and gets
a little more so every minute the daemon runs. Reverting to ledger 98 fixes both.

**What you keep by reverting instead of restoring the backup:** about 4.5 hours
of work — 130 messages, 126 issue messages, 12 read markers and 1 session that
the backup does not contain.

**What the reversal costs:** two deliberate row merges (a read marker and a feed
index entry that exist under both spellings of your user id get combined into
one), and every connected client is asked to resync. Nothing else.

---

## Before you start — copy these two paths somewhere you can read offline

    Script folder:
      /home/mgw/src/other/podium-cloud/.worktrees/issue-107-multi-user-architecture/oss/podium/ops/db-reversal-ledger-98

    Protected ledger-98 backup (your last-resort fallback — do not delete):
      /home/mgw/podium-db-rescue/podium.db.backup-vdrizzle-98-2026-09-13T04-46-31-487Z

Write them on paper or in a text file outside Podium. If anything goes wrong,
the second path is a complete, verified, working database.

---

## Step 1 — stop Podium

**Use systemd. Do NOT use `kill`.** The service is configured `Restart=always`,
so a killed Podium comes back about two seconds later — on top of the reversal.
That is exactly how this incident started.

    systemctl --user stop podium.service

Confirm it is really down:

    systemctl --user is-active podium.service

**Correct output:** `inactive`

Now confirm nothing at all still holds the database open:

    ls -l /proc/*/fd/* 2>/dev/null | grep podium.db ; echo "exit=$?"

**Correct output:** no lines about `podium.db`, and `exit=1`.
If you see lines here, something is still running. Find the number after
`/proc/` and check what it is with `ps -p <number> -o cmd=`, then stop that too.

From this moment you cannot reach your assistant. That is expected.

---

## Step 2 — rehearse (changes nothing)

    cd /home/mgw/src/other/podium-cloud/.worktrees/issue-107-multi-user-architecture/oss/podium/ops/db-reversal-ledger-98
    ./revert-to-ledger-98.sh --db /home/mgw/.podium/podium.db

This copies your database to a scratch file, reverts **the copy**, and checks it
against the protected ledger-98 backup. Your real database is opened read-only.
It takes about a minute.

**Correct output ends with:**

    ----------------------------------------------------------------------
      ALL CHECKS PASSED on the dry run. Your real database was NOT touched.

Along the way you should see all six checks pass:

    Check 1/6 ... clean            (with one "(expected)" line about superagent_threads.id)
    Check 2/6: PRAGMA integrity_check        ok
    Check 3/6: PRAGMA foreign_key_check      empty -- no broken references
    Check 4/6: the ledger                    98   20260831232155_transcript-costs
    Check 5/6 ... clean -- the split brain is healed
    Check 6/6 ... master/cols/idx/trig all IDENTICAL

A block of lines about "both spellings (collision CANDIDATE...)" before the
checks is **normal**. Those are columns holding both spellings of your user id;
the script handles them.

**If the dry run does not say ALL CHECKS PASSED, stop.** Do not use `--apply`.
Go to **FALLBACK**.

---

## Step 3 — do it for real

Same command with `--apply` added:

    ./revert-to-ledger-98.sh --db /home/mgw/.podium/podium.db --apply

It will show you what it is about to do and ask you to type a phrase. Type
exactly:

    revert to ledger 98

It then takes a full backup of your database **before** touching it, writes it to
`~/podium-db-rescue-preapply/`, verifies that backup opens cleanly, and only then
runs the reversal as a single transaction.

**Correct output ends with:**

    ----------------------------------------------------------------------
      ALL CHECKS PASSED. The database is now at ledger 98.

        database : /home/mgw/.podium/podium.db
        backup   : /home/mgw/podium-db-rescue-preapply/podium.db.pre-ledger-98-revert-<timestamp>

**Write that backup path down.** Keep it until step 4 succeeds.

---

## Step 4 — did it work?

Check the database directly before starting anything:

    sqlite3 /home/mgw/.podium/podium.db "SELECT count(*) FROM __drizzle_migrations;"

**Correct output:** `98`

    sqlite3 /home/mgw/.podium/podium.db "SELECT count(*) FROM issues;"

**Correct output:** `4296`

    sqlite3 /home/mgw/.podium/podium.db "SELECT id FROM users;"

**Correct output:** `user:sole`

Now start Podium:

    systemctl --user start podium.service
    systemctl --user is-active podium.service

**Correct output:** `active`

Open Podium as you normally would. Your clients will resync once — that is
deliberate; the reversal rotates the feed epoch so that any client which synced
during the broken window throws away what it cached.

If it all looks right, you are done. Keep the pre-apply backup for a few days,
then delete it to reclaim the space.

---

## What every failure message means

The script never fails silently. Every stop prints a block starting
`## STOPPED:` and tells you whether the database was changed. Here is what each
one means.

| Message | What it means | What to do |
|---|---|---|
| `the Podium server is still running` | Something still has the database open. | Go back to step 1. Use `systemctl --user stop podium.service`, never `kill`. |
| `this database is ALREADY at ledger 98` | You already ran it successfully. | Nothing is wrong. Go to step 4. Running the script twice is harmless — it stops here. |
| `not enough free disk space` | There is not room for the safety backup. | Free space elsewhere, or pass `--backup-dir /some/other/disk`. Never delete anything in `/home/mgw/.podium`. |
| `sqlite3 is not installed` | Missing the one tool this needs. | `sudo apt-get install -y sqlite3` |
| `your sqlite3 is too old` | Needs 3.27.0 or newer. | `sudo apt-get install -y sqlite3` |
| `the reference database you named does not exist` | The protected ledger-98 backup is gone or moved. | Find it. If it is truly gone, see FALLBACK — and take a fresh copy of your database before anything else. |
| `there is already a dry-run copy in the work directory` | Leftover from a previous run. | Delete the file it names, or just re-run without `--work-dir`. |
| `the folder this script lives in has a space` | `sqlite3` cannot read the SQL files from such a path. | `cp -r <folder> /tmp/db-reversal` and run it from there. |
| `some of the SQL files this script needs are missing` | You copied the script without its folder. | Copy the whole folder — all nine `.sql` files must sit next to the script. |
| `you did not confirm` | The typed phrase did not match. | Run again and type `revert to ledger 98` exactly. |
| `needs you to confirm at the keyboard` | Run from a pipe or a job, not a terminal. | Run it yourself in a terminal. |
| `preflight: ...` anything | The database is not in the exact state the script was written for. | **Stop.** Do not work around it. Go to FALLBACK. |
| `the DRY RUN did not pass all its checks` | The rehearsal found a problem. Your database was not touched. | **Stop.** Go to FALLBACK. |

**The rule that covers everything not in this table:** if the message says the
database was NOT changed, you can safely fix the stated problem and run again.
If it says the reversal was already committed, follow the restore commands the
script prints — it prints them with your actual paths filled in.

---

## FALLBACK — restore the protected ledger-98 backup

Use this when the reversal will not run, or ran and you do not trust the result.
You lose about 4.5 hours of messages and read markers. You get a complete,
verified, working database.

With Podium **stopped** (step 1):

    # 1. Keep whatever you have now, just in case — it is not in the way.
    cp /home/mgw/.podium/podium.db /home/mgw/podium.db.broken-$(date +%Y%m%d-%H%M%S)

    # 2. Remove the write-ahead log files. This matters: leaving them behind
    #    lets SQLite replay old changes over the restored file.
    rm -f /home/mgw/.podium/podium.db-wal /home/mgw/.podium/podium.db-shm

    # 3. Put the good database in place.
    cp /home/mgw/podium-db-rescue/podium.db.backup-vdrizzle-98-2026-09-13T04-46-31-487Z \
       /home/mgw/.podium/podium.db

    # 4. Make it writable (the protected copy is read-only on purpose).
    chmod u+w /home/mgw/.podium/podium.db

    # 5. Check it.
    sqlite3 /home/mgw/.podium/podium.db "PRAGMA integrity_check;"          # want: ok
    sqlite3 /home/mgw/.podium/podium.db "SELECT count(*) FROM __drizzle_migrations;"   # want: 98
    sqlite3 /home/mgw/.podium/podium.db "SELECT count(*) FROM issues;"     # want: 4296

Then start Podium (step 4).

**Never delete anything in `/home/mgw/podium-db-rescue/`.** That directory is the
floor underneath every other option on this page.

---

## Undoing a completed reversal

If you ran `--apply` successfully but want the ledger-107 database back, the
pre-apply backup is an exact copy of it. With Podium stopped:

    rm -f /home/mgw/.podium/podium.db-wal /home/mgw/.podium/podium.db-shm
    cp /home/mgw/podium-db-rescue-preapply/podium.db.pre-ledger-98-revert-<timestamp> \
       /home/mgw/.podium/podium.db
    sqlite3 /home/mgw/.podium/podium.db "PRAGMA integrity_check;"    # want: ok

Note that your server still cannot open a ledger-107 database — that is the
original problem — so this is only useful if you are handing the file to someone
with a newer build.

---

## Why this will not simply happen again

The Podium you have installed does not contain any of the nine migrations. That
is verifiable without running it:

    grep -ac "retire-the-solo-user" /home/mgw/.local/share/podium/podium-cli

**Output `0`** means this build cannot apply migration 99, so starting it on a
ledger-98 database applies nothing and changes nothing.

The way this recurs is by **starting a newer build** — one that does contain
those migrations — against this database. Until the epic ships and you migrate
deliberately, do not run a Podium built from the multi-user branch against
`/home/mgw/.podium/podium.db`.

---

## Quick reference

    # stop
    systemctl --user stop podium.service
    systemctl --user is-active podium.service          # want: inactive

    # rehearse
    cd /home/mgw/src/other/podium-cloud/.worktrees/issue-107-multi-user-architecture/oss/podium/ops/db-reversal-ledger-98
    ./revert-to-ledger-98.sh --db /home/mgw/.podium/podium.db

    # apply  (type: revert to ledger 98)
    ./revert-to-ledger-98.sh --db /home/mgw/.podium/podium.db --apply

    # verify
    sqlite3 /home/mgw/.podium/podium.db "SELECT count(*) FROM __drizzle_migrations;"   # 98
    sqlite3 /home/mgw/.podium/podium.db "SELECT count(*) FROM issues;"                 # 4296

    # start
    systemctl --user start podium.service
