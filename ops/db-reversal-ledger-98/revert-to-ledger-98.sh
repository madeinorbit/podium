#!/usr/bin/env bash
#
# REVERT A PODIUM DATABASE FROM LEDGER 107 TO LEDGER 98.
#
#   ./revert-to-ledger-98.sh --db <path> [--reference <ledger-98 backup>] [--apply]
#
# Default is a DRY RUN: it copies the database, reverts the COPY, verifies it,
# and leaves the original untouched. `--apply` reverts the database named by
# --db in place, after taking its own backup.
#
# READ RUNBOOK.md FIRST. It is a single page, it assumes you are alone, and it
# has the exact commands in order. This header is the reasoning; that is the
# procedure.
#
# WHY A SCRIPT AND NOT A MIGRATION. This repo's migrations are forward-only on
# purpose (scripts/audit-expand-only-migrations.ts states the policy and enforces
# it), so there is no `down` to write. And a forward migration could not do this
# job even if one were written: drizzle records its own ledger row after running
# a migration's SQL, so migration 108 "undo 99..107" would leave row 108 behind,
# which the shipping build does not define either -- the same downgrade refusal,
# one row further on. Reaching ledger 98 EXACTLY means editing the ledger from
# outside the migrator. This script is that edit, made reviewable: every
# statement is in a file next to it, the whole set runs in one transaction, and
# it refuses to start unless the database is in the exact state it expects.
#
# IT DOES NOT BOOT PODIUM. sqlite3(1) only -- no podium, no bun, no node, no
# network. An accidental instance boot is what caused the incident this reverses.
#
# THE SERVER MUST BE STOPPED, and this script now ENFORCES that for --apply
# rather than only asking for it in a comment. A running daemon holds the
# database open and keeps writing rows under the old identity while the reversal
# moves them, which grows the collision surface under the script's feet.

set -euo pipefail

MEM="mem_3JG5vkeZMwNpSHWA3K3AGFaLxp8"

# The write-protected ledger-98 copy. This is the fallback if everything else
# fails: it is a whole, verified database, it is 4.5 hours behind, and restoring
# it is a file copy. Never written to by this script.
PROTECTED_REF="/home/mgw/podium-db-rescue/podium.db.backup-vdrizzle-98-2026-09-13T04-46-31-487Z"

# VACUUM INTO needs 3.27.0 (2019-02); pragma table-valued functions need 3.16.0.
MIN_SQLITE_NUM=3027000
MIN_SQLITE_TXT="3.27.0"

# ---------------------------------------------------------------- reporting --

PHASE="startup"      # startup | before-commit | after-commit
APPLY=0
DB=""
BACKUP=""
TARGET=""

rule() { printf '%s\n' "----------------------------------------------------------------------"; }
say()  { printf '\n=== %s\n' "$*"; }

# abort <one-line headline> <what to do, one arg per line>
abort() {
  local headline="$1"; shift
  {
    printf '\n\n'
    printf '######################################################################\n'
    printf '##  STOPPED: %s\n' "$headline"
    printf '######################################################################\n\n'
    printf 'WHAT STATE IS THE DATABASE IN?\n\n'
    case "$PHASE" in
      startup|before-commit)
        printf '  The database was NOT changed. Nothing was written to it. It is\n'
        printf '  exactly as it was before you ran this. It is safe to fix the\n'
        printf '  problem below and run this script again.\n'
        ;;
      after-commit)
        printf '  *** THE REVERSAL WAS ALREADY COMMITTED. The database HAS changed. ***\n\n'
        if [ "$APPLY" = "1" ] && [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
          printf '  A backup of the database as it was BEFORE this run is at:\n\n'
          printf '      %s\n\n' "$BACKUP"
          printf '  To put the database back exactly as it was, with the server still\n'
          printf '  stopped, run these three commands:\n\n'
          printf '      rm -f "%s-wal" "%s-shm"\n' "$DB" "$DB"
          printf '      cp "%s" "%s"\n' "$BACKUP" "$DB"
          printf '      sqlite3 "%s" "PRAGMA integrity_check;"    # must print: ok\n\n' "$DB"
        else
          printf '  This was a DRY RUN, so the change happened only to the throwaway\n'
          printf '  copy. Your real database was never opened for writing.\n\n'
        fi
        ;;
    esac
    printf '\nWHAT WENT WRONG, AND WHAT TO DO ABOUT IT\n\n'
    while [ $# -gt 0 ]; do printf '  %s\n' "$1"; shift; done
    printf '\nIF YOU CANNOT GET PAST THIS\n\n'
    printf '  You do not have to make this work. There is a complete, verified\n'
    printf '  ledger-98 database here:\n\n'
    printf '      %s\n\n' "$PROTECTED_REF"
    printf '  Restoring it loses about 4.5 hours of messages and reads, but it is\n'
    printf '  a whole working database and the server will start on it. RUNBOOK.md,\n'
    printf '  section "FALLBACK", has the exact commands.\n\n'
    rule
  } >&2
  exit 1
}

on_err() {
  local rc=$? line=${1:-?}
  abort "an unexpected error (exit $rc) at line $line of this script." \
        "This is not one of the checks below failing on purpose -- it is the" \
        "script itself hitting something it did not plan for. The most common" \
        "causes are a full disk, a database file that another program is" \
        "holding, or a file that is not readable." \
        "" \
        "Check free space with:   df -h \"$(dirname "${DB:-/}")\"" \
        "Check nothing holds the database with the command in RUNBOOK.md step 1."
}
trap 'on_err $LINENO' ERR

# ------------------------------------------------------------------- usage --

usage() {
  cat <<'USAGE'
Revert a Podium database from drizzle ledger 107 back to ledger 98.

  revert-to-ledger-98.sh --db <path> [options]

  --db <path>          The database to work on. Required.
  --reference <path>   A known-good ledger-98 database to compare the result
                       against. Strongly recommended. Defaults to the protected
                       copy if that exists.
  --apply              Change the database named by --db IN PLACE. Without this
                       flag the script only reverts a throwaway copy (dry run).
  --backup-dir <path>  Where --apply writes its before-picture backup.
                       Default: $HOME/podium-db-rescue-preapply
  --work-dir <path>    Where scratch files go. Default: a fresh temp directory.
  --yes                Skip the typed confirmation for --apply. Only for
                       unattended use; you almost certainly do not want this.
  -h, --help           This text.

Read RUNBOOK.md in this directory before using --apply.
USAGE
}

# ------------------------------------------------------------ command line --

REF=""; KEEP=""; BACKUP_DIR=""; ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db)         [ $# -ge 2 ] || abort "--db needs a path after it." "Write:  --db /home/mgw/.podium/podium.db"; DB="$2"; shift 2 ;;
    --reference)  [ $# -ge 2 ] || abort "--reference needs a path after it." "Or leave it off entirely to use the protected copy."; REF="$2"; shift 2 ;;
    --backup-dir) [ $# -ge 2 ] || abort "--backup-dir needs a path after it." "Or leave it off to use the default."; BACKUP_DIR="$2"; shift 2 ;;
    --work-dir)   [ $# -ge 2 ] || abort "--work-dir needs a path after it." "Or leave it off to use a temp directory."; KEEP="$2"; shift 2 ;;
    --apply)      APPLY=1; shift ;;
    --yes)        ASSUME_YES=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) usage >&2; abort "unknown argument: $1" "Run with --help to see the arguments this script accepts." ;;
  esac
done

[ -n "$DB" ] || { usage >&2; abort "you did not say which database to work on." \
    "Add --db and the path, for example:" \
    "" \
    "    ./revert-to-ledger-98.sh --db /home/mgw/.podium/podium.db"; }

# ------------------------------------------------- environment preflight ----
# Everything in this block runs BEFORE the database is opened for anything.

command -v sqlite3 >/dev/null 2>&1 || abort "sqlite3 is not installed, and this script cannot run without it." \
  "This script uses exactly one program: sqlite3. Install it with:" \
  "" \
  "    sudo apt-get install -y sqlite3" \
  "" \
  "It needs no network, no Podium, no bun and no node."

SQLITE_VER="$(sqlite3 --version 2>/dev/null | awk '{print $1}')"
SQLITE_NUM="$(printf '%s' "$SQLITE_VER" | awk -F. '{printf "%d%03d%03d", $1, $2, $3}')"
[ "${SQLITE_NUM:-0}" -ge "$MIN_SQLITE_NUM" ] 2>/dev/null || abort "your sqlite3 is too old." \
  "Found version: ${SQLITE_VER:-unknown}. This script needs $MIN_SQLITE_TXT or newer," \
  "because it uses VACUUM INTO to make safe copies." \
  "" \
  "Upgrade with:   sudo apt-get install -y sqlite3"

# Paths containing whitespace or shell metacharacters break sqlite3's .read
# dot-command, which has no quoting of its own. Refuse rather than misbehave.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
case "$HERE" in
  *[[:space:]\'\"\\\$\`]*) abort "the folder this script lives in has a space or a quote in its name." \
    "sqlite3 cannot read the .sql files from a path like that. The folder is:" \
    "" \
    "    $HERE" \
    "" \
    "Fix it by copying this whole folder somewhere simple and running it there:" \
    "" \
    "    cp -r \"$HERE\" /tmp/db-reversal && /tmp/db-reversal/revert-to-ledger-98.sh --db <path>" ;;
esac

SQL_FILES="00-preflight.sql
10-contract-107-106-managed-credentials.sql
20-contract-105-104-103-99-issues.sql
30-contract-103-ownership-schema.sql
40-contract-102-101-100-members.sql
50-contract-099-identity-rekey.sql
60-contract-099-table-shapes.sql
70-ledger-98.sql
90-postcheck.sql"
MISSING=""
while read -r f; do [ -f "$HERE/$f" ] || MISSING="$MISSING $f"; done <<< "$SQL_FILES"
[ -z "$MISSING" ] || abort "some of the SQL files this script needs are missing." \
  "Missing from $HERE :" \
  "   $MISSING" \
  "" \
  "All nine .sql files must sit next to this script. If you copied the script" \
  "on its own, copy the whole folder instead."

[ -f "$DB" ] || abort "there is no database at the path you gave." \
  "You said:  $DB" \
  "" \
  "Check the path. The live tracker is normally:" \
  "" \
  "    /home/mgw/.podium/podium.db"
[ -r "$DB" ] || abort "the database file cannot be read." "You said:  $DB"

case "$DB" in *[[:space:]\'\"\\\$\`]*) abort "the database path has a space or a quote in it." \
  "You said:  $DB" "Move or rename it to a path without spaces and try again." ;; esac

# Default the reference to the protected copy when it is there.
if [ -z "$REF" ] && [ -f "$PROTECTED_REF" ] && [ "$PROTECTED_REF" != "$DB" ]; then
  REF="$PROTECTED_REF"
fi
if [ -n "$REF" ]; then
  [ -f "$REF" ] || abort "the reference database you named does not exist." \
    "You said:  $REF" \
    "" \
    "The protected ledger-98 copy should be at:" \
    "" \
    "    $PROTECTED_REF" \
    "" \
    "If that file is gone, you can still run WITHOUT a reference -- pass" \
    "--reference '' -- but then the script cannot prove the result matches a" \
    "known-good ledger-98 schema. Prefer finding the backup first."
  [ -r "$REF" ] || abort "the reference database cannot be read." "You said:  $REF"
fi

# ------------------------------------------------------ is the server up? --
# Definitive test, needing no extra tools: ask the kernel who has the file open.
# Only processes owned by this user are visible, which is the case that matters.

holders() {
  local target="$1" fd tgt pid
  for fd in /proc/[0-9]*/fd/*; do
    tgt="$(readlink "$fd" 2>/dev/null)" || continue
    case "$tgt" in
      "$target"|"$target-wal"|"$target-shm"|"$target-journal")
        pid="${fd#/proc/}"; pid="${pid%%/*}"
        printf '%s\t%s\n' "$pid" "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-100)"
        ;;
    esac
  done | sort -u
}

SELF_CHECK_HINT="    ls -l \"$(dirname "$DB")\"/podium.db-wal   # the -wal stops growing"
DB_ABS="$(cd "$(dirname "$DB")" && pwd -P)/$(basename "$DB")"
HOLDERS="$(holders "$DB_ABS" || true)"
LOCKFILE="$(dirname "$DB_ABS")/daemon.lock"

if [ -n "$HOLDERS" ]; then
  say "A PROGRAM IS HOLDING THIS DATABASE OPEN"
  printf '%s\n' "$HOLDERS" | while IFS="$(printf '\t')" read -r p c; do printf '  pid %-8s %s\n' "$p" "$c"; done
  [ -f "$LOCKFILE" ] && printf '  (%s also exists)\n' "$LOCKFILE"
  if command -v systemctl >/dev/null 2>&1; then
    UNIT_STATE="$(systemctl --user is-active podium.service 2>/dev/null || true)"
    [ -n "$UNIT_STATE" ] && printf '  systemd unit podium.service is: %s\n' "$UNIT_STATE"
  fi
  if [ "$APPLY" = "1" ]; then
    abort "the Podium server is still running, so --apply is refused." \
      "The processes above have the database open. Almost certainly this is" \
      "the Podium daemon. It must be stopped before the reversal runs, for two" \
      "reasons:" \
      "" \
      "  * it keeps writing rows under the OLD identity while the reversal is" \
      "    moving them, so the work grows under the script's feet;" \
      "  * a write that lands between the backup and the reversal is a change" \
      "    that the backup does not contain." \
      "" \
      "STOP IT WITH SYSTEMD. Do NOT use kill: the service is set to" \
      "Restart=always, so systemd starts Podium again about two seconds" \
      "later -- on top of the reversal, which is how this mess began." \
      "" \
      "    systemctl --user stop podium.service" \
      "" \
      "Then check nothing holds it any more:" \
      "" \
      "    systemctl --user is-active podium.service      # want: inactive" \
      "$SELF_CHECK_HINT" \
      "" \
      "and run this command again. You will not be able to reach your" \
      "assistant while Podium is down; that is expected, and RUNBOOK.md is" \
      "written for exactly that."
  else
    printf '\n  This is only a DRY RUN, so it is safe to continue -- the copy is\n'
    printf '  taken from a live file and may be a few seconds stale, which does\n'
    printf '  not matter for a rehearsal.\n'
    printf '\n  *** BUT: you MUST stop the server before running with --apply. ***\n'
  fi
else
  say "Nothing is holding the database open (server appears stopped) -- good"
fi

# ------------------------------------------------------------ disk space ----

avail_bytes() { df -PB1 "$1" 2>/dev/null | awk 'NR==2{print $4}'; }
human() { awk -v b="$1" 'BEGIN{printf "%.1f GB", b/1073741824}'; }

DB_BYTES="$(stat -c %s "$DB")"

WORK="${KEEP:-$(mktemp -d -t ledger98-revert-XXXXXX)}"
mkdir -p "$WORK"
case "$WORK" in *[[:space:]\'\"\\\$\`]*) abort "the work directory path has a space or a quote in it." \
  "You said:  $WORK" "Choose a path without spaces, or leave --work-dir off." ;; esac

# The dry run needs one full copy in the work directory.
NEED_WORK=$(( DB_BYTES * 12 / 10 ))
HAVE_WORK="$(avail_bytes "$WORK")"
if [ "$APPLY" != "1" ]; then
  [ "${HAVE_WORK:-0}" -ge "$NEED_WORK" ] || abort "there is not enough free disk space for the dry run." \
    "The dry run copies the whole database. It needs about $(human "$NEED_WORK") free" \
    "in $WORK but only $(human "${HAVE_WORK:-0}") is available." \
    "" \
    "Either free some space, or point --work-dir at a disk that has room:" \
    "" \
    "    ./revert-to-ledger-98.sh --db \"$DB\" --work-dir /path/with/room"
fi

if [ "$APPLY" = "1" ]; then
  BACKUP_DIR="${BACKUP_DIR:-$HOME/podium-db-rescue-preapply}"
  mkdir -p "$BACKUP_DIR"
  case "$BACKUP_DIR" in *[[:space:]\'\"\\\$\`]*) abort "the backup directory path has a space or a quote in it." \
    "You said:  $BACKUP_DIR" "Choose a path without spaces." ;; esac
  [ -w "$BACKUP_DIR" ] || abort "the backup directory is not writable." \
    "You said:  $BACKUP_DIR" \
    "--apply will not run without somewhere to put the before-picture backup."

  # Backup is a full compacted copy; the reversal itself peaks at about 1.2x the
  # database size on the database's own filesystem (measured: journal + growth).
  NEED_BACKUP=$(( DB_BYTES * 12 / 10 ))
  NEED_DBFS=$(( DB_BYTES * 4 / 10 ))
  HAVE_BACKUP="$(avail_bytes "$BACKUP_DIR")"
  HAVE_DBFS="$(avail_bytes "$(dirname "$DB_ABS")")"
  # Same filesystem? then both demands come out of the same pool.
  if [ "$(stat -c %d "$BACKUP_DIR")" = "$(stat -c %d "$(dirname "$DB_ABS")")" ]; then
    NEED_TOTAL=$(( NEED_BACKUP + NEED_DBFS ))
    [ "${HAVE_DBFS:-0}" -ge "$NEED_TOTAL" ] || abort "there is not enough free disk space to apply the reversal safely." \
      "The backup and the database are on the same disk, which needs about" \
      "$(human "$NEED_TOTAL") free ($(human "$NEED_BACKUP") for the backup copy, $(human "$NEED_DBFS") for the" \
      "reversal's own journal). Only $(human "${HAVE_DBFS:-0}") is available." \
      "" \
      "Put the backup on another disk instead:" \
      "" \
      "    ./revert-to-ledger-98.sh --db \"$DB\" --apply --backup-dir /other/disk" \
      "" \
      "Do NOT free space by deleting anything in $(dirname "$DB_ABS") -- the" \
      "database's own files live there."
  else
    [ "${HAVE_BACKUP:-0}" -ge "$NEED_BACKUP" ] || abort "there is not enough free space where the backup would go." \
      "Needs about $(human "$NEED_BACKUP") in $BACKUP_DIR, has $(human "${HAVE_BACKUP:-0}")."
    [ "${HAVE_DBFS:-0}" -ge "$NEED_DBFS" ] || abort "there is not enough free space on the database's own disk." \
      "The reversal's journal needs about $(human "$NEED_DBFS") free next to" \
      "$DB_ABS, but only $(human "${HAVE_DBFS:-0}") is available."
  fi
fi

# --------------------------------------------- is this database revertible? --
# A cheap read-only probe BEFORE anything is copied, so the commonest mistakes
# (already reverted, wrong database) are reported in one plain sentence instead
# of as a CHECK-constraint failure deep inside a transaction.

LEDGER_ROWS="$(sqlite3 "file:$DB?mode=ro" "SELECT count(*) FROM __drizzle_migrations;" 2>/dev/null || echo "?")"
case "$LEDGER_ROWS" in
  107) : ;;
  98)  abort "this database is ALREADY at ledger 98. There is nothing to revert." \
         "The ledger has 98 rows, which is where the reversal is trying to get to." \
         "" \
         "If you have already run this successfully, you are done -- go to" \
         "RUNBOOK.md section \"DID IT WORK?\" and start the server." \
         "" \
         "Running this script twice does no harm: it stops here, like now." ;;
  "?") abort "this file does not look like a Podium database." \
         "Reading its migration ledger failed. You said:" \
         "" \
         "    $DB" \
         "" \
         "Check the path, and check the file is not damaged:" \
         "" \
         "    sqlite3 \"$DB\" \"PRAGMA integrity_check;\"" ;;
  *)   abort "this database is at an unexpected point in its migration history." \
         "Its ledger has $LEDGER_ROWS rows. This script only knows how to revert a" \
         "database with exactly 107 -- the nine unreleased migrations on top of 98." \
         "" \
         "Do not force it. Stop here and use the fallback described below." ;;
esac

# ------------------------------------------------------------- confirmation --

if [ "$APPLY" = "1" ] && [ "$ASSUME_YES" != "1" ]; then
  say "YOU ARE ABOUT TO CHANGE A REAL DATABASE"
  rule
  printf '  database : %s  (%s)\n' "$DB_ABS" "$(human "$DB_BYTES")"
  printf '  backup   : %s/\n' "$BACKUP_DIR"
  printf '  reference: %s\n' "${REF:-<none -- the result will NOT be schema-checked>}"
  rule
  printf '\n  This rewrites the database in place. A backup is taken first, and\n'
  printf '  the whole change is one transaction -- if any check fails, nothing\n'
  printf '  is written at all.\n'
  printf '\n  Have you already run this WITHOUT --apply and seen "ALL CHECKS\n'
  printf '  PASSED"? If not, press Ctrl-C and do that first.\n'
  if [ ! -t 0 ]; then
    abort "--apply needs you to confirm at the keyboard, and there is no keyboard here." \
      "This script was run without a terminal attached (a pipe, a cron job, or" \
      "a background task). Applying a change to a real database from an" \
      "unattended context is not allowed." \
      "" \
      "Run it yourself in a terminal, or -- only if you are certain -- add --yes."
  fi
  printf '\n  Type exactly:  revert to ledger 98\n  > '
  IFS= read -r reply || reply=""
  [ "$reply" = "revert to ledger 98" ] || abort "you did not confirm, so nothing was done." \
    "The confirmation phrase did not match, so the script stopped before" \
    "opening the database for writing." \
    "" \
    "If you meant to go ahead, run the same command again and type:" \
    "" \
    "    revert to ledger 98"
fi

# ---------------------------------------------------------------- the work --

if [ "$APPLY" = "1" ]; then
  TARGET="$DB"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP="$BACKUP_DIR/$(basename "$DB").pre-ledger-98-revert-$STAMP"
  say "APPLY MODE. Backing up $DB"
  printf '  -> %s\n' "$BACKUP"
  sqlite3 "file:$DB?mode=ro" "VACUUM INTO '$BACKUP';"
  ls -l "$BACKUP"
  say "Verifying that backup is readable before going any further"
  BK_OK="$(sqlite3 "file:$BACKUP?mode=ro" "PRAGMA integrity_check;" 2>/dev/null || echo failed)"
  [ "$BK_OK" = "ok" ] || abort "the backup this script just took is not a healthy database." \
    "integrity_check on the backup said: $BK_OK" \
    "" \
    "Refusing to change the real database when the safety net is bad." \
    "This usually means the disk is full or failing. Check:" \
    "" \
    "    df -h \"$BACKUP_DIR\""
  BK_LEDGER="$(sqlite3 "file:$BACKUP?mode=ro" "SELECT count(*) FROM __drizzle_migrations;")"
  printf '  backup verified: integrity ok, ledger rows = %s\n' "$BK_LEDGER"
else
  TARGET="$WORK/dry-run.db"
  [ -e "$TARGET" ] && abort "there is already a dry-run copy in the work directory." \
    "Found: $TARGET" \
    "" \
    "This is left over from a previous run. Delete it, or use a fresh" \
    "work directory:" \
    "" \
    "    rm -f \"$TARGET\"" \
    "    # or" \
    "    ./revert-to-ledger-98.sh --db \"$DB\"        # no --work-dir = fresh temp dir"
  say "DRY RUN. Copying $DB -> $TARGET (the original is not touched)"
  sqlite3 "file:$DB?mode=ro" "VACUUM INTO '$TARGET';"
fi

# Enumerate every column of every table once, and REFUSE to continue if that
# enumeration comes back empty -- an empty list would make both scans below
# report "clean" without having looked at anything.
COLS="$(sqlite3 "$TARGET" "select t.name||'|'||c.name from sqlite_master t join pragma_table_info(t.name) c where t.type='table' and t.name not like 'sqlite_%';")"
COLS_N="$(printf '%s\n' "$COLS" | grep -c . || true)"
[ "${COLS_N:-0}" -ge 500 ] || abort "the script could not list the database's columns, so its safety scans would be meaningless." \
  "Expected around 936 columns, got ${COLS_N:-0}." \
  "" \
  "Refusing to continue: a scan over an empty list would report \"clean\"" \
  "without having checked anything. The database may be damaged:" \
  "" \
  "    sqlite3 \"$TARGET\" \"PRAGMA integrity_check;\""

say "Collision surface: columns holding BOTH spellings of the principal id ($COLS_N columns scanned)"
# The still-running ledger-98 binary writes the literal 'user:sole' into a
# database whose rows say the minted member id. Where both spellings land in the
# same uniquely-keyed column, reversing the rekey is a primary-key violation
# rather than an UPDATE. Two such columns are handled by explicit merges
# (issue_user_state in 30-*.sql, change_latest in 50-*.sql); any OTHER column
# listed here is one the reversal does not yet merge, and the transaction will
# abort on it rather than write a half-reverted database. The cure is to stop
# the daemon: with nothing writing, the surface stops growing.
while IFS='|' read -r t c; do
  [ -n "$t" ] || continue
  both=$(sqlite3 "$TARGET" "select (select count(*) from \"$t\" where \"$c\" = '$MEM') > 0 and (select count(*) from \"$t\" where \"$c\" = 'user:sole') > 0;" 2>/dev/null || echo 0)
  [ "${both:-0}" = "1" ] && echo "  both spellings (collision CANDIDATE; only a shared key is a real collision): $t.$c"
done <<< "$COLS"
echo "  (scan complete -- these are expected; a real collision aborts the transaction below)"

say "Applying the reversal in ONE transaction"
PHASE="before-commit"
sqlite3 "$TARGET" <<SQL
.bail on
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
.read $HERE/00-preflight.sql
.read $HERE/10-contract-107-106-managed-credentials.sql
.read $HERE/20-contract-105-104-103-99-issues.sql
.read $HERE/30-contract-103-ownership-schema.sql
.read $HERE/40-contract-102-101-100-members.sql
.read $HERE/50-contract-099-identity-rekey.sql
.read $HERE/60-contract-099-table-shapes.sql
.read $HERE/70-ledger-98.sql
.read $HERE/90-postcheck.sql
COMMIT;
SQL
PHASE="after-commit"

# ------------------------------------------------------------ verification --
# Everything from here on is a CHECK, and every one of them is now fatal. Before
# this rewrite they printed their result and the script exited 0 regardless.

FAILED=0
note_fail() { FAILED=1; printf '  *** FAILED: %s\n' "$1"; }

say "Check 1/6: no column may still hold the minted member id"
# Re-enumerate the columns AFTER the reversal. The list taken before it is the
# ledger-107 shape: it names columns that are now gone, and -- the reason this
# matters -- it does NOT name `issues.assignee`, which the reversal itself
# recreates and refills from `retired_assignee`. Scanning the stale list would
# skip the one column whose contents this script reconstructed.
COLS_AFTER="$(sqlite3 "$TARGET" "select t.name||'|'||c.name from sqlite_master t join pragma_table_info(t.name) c where t.type='table' and t.name not like 'sqlite_%';")"
COLS_AFTER_N="$(printf '%s\n' "$COLS_AFTER" | grep -c . || true)"
[ "${COLS_AFTER_N:-0}" -ge 500 ] || abort "the script could not list the reverted database's columns, so this scan would be meaningless." \
  "Expected around 936 columns, got ${COLS_AFTER_N:-0}."
printf '  %s columns scanned, including the rebuilt issues.assignee\n' "$COLS_AFTER_N"
grep -qx 'issues|assignee' <<< "$COLS_AFTER" || abort "issues.assignee is missing from the reverted database." \
  "The reversal is supposed to bring that column back and it is not there." \
  "Do not start the server on this database."
HITS=0
while IFS='|' read -r t c; do
  [ -n "$t" ] || continue
  n=$(sqlite3 "$TARGET" "select count(*) from \"$t\" where \"$c\" is not null and instr(cast(\"$c\" as text), '$MEM')>0;" 2>/dev/null || echo 0)
  if [ "${n:-0}" != "0" ]; then
    # superagent_threads.id is deliberately left alone -- see 50-*.sql.
    if [ "$t.$c" = "superagent_threads.id" ]; then
      echo "  (expected) $t.$c: $n  -- a primary key minted after the accident, left as found"
    else
      echo "  SURVIVING MINTED ID: $t.$c: $n"; HITS=$((HITS+1))
    fi
  fi
done <<< "$COLS_AFTER"
if [ "$HITS" = "0" ]; then echo "  clean"; else note_fail "the minted id survives in $HITS column(s)"; fi

say "Check 2/6: PRAGMA integrity_check"
IC="$(sqlite3 "$TARGET" "PRAGMA integrity_check;")"
if [ "$IC" = "ok" ]; then echo "  ok"; else printf '%s\n' "$IC" | head -20; note_fail "integrity_check did not say ok"; fi

say "Check 3/6: PRAGMA foreign_key_check (must be empty)"
FK="$(sqlite3 "$TARGET" "PRAGMA foreign_key_check;")"
FK_N="$(printf '%s' "$FK" | grep -c . || true)"
if [ "${FK_N:-0}" = "0" ]; then echo "  empty -- no broken references"; else printf '%s\n' "$FK" | head -20; note_fail "$FK_N broken foreign-key reference(s)"; fi

say "Check 4/6: the ledger"
sqlite3 -header -column "$TARGET" "select count(*) rows, (select name from __drizzle_migrations order by name desc limit 1) newest from __drizzle_migrations;" | sed 's/^/  /'
L_ROWS="$(sqlite3 "$TARGET" "select count(*) from __drizzle_migrations;")"
L_NAME="$(sqlite3 "$TARGET" "select name from __drizzle_migrations order by name desc limit 1;")"
[ "$L_ROWS" = "98" ] || note_fail "the ledger has $L_ROWS rows, not 98"
[ "$L_NAME" = "20260831232155_transcript-costs" ] || note_fail "the newest ledger name is '$L_NAME', not transcript-costs"

say "Check 5/6: every principal id resolves to a real user row"
ORPH="$(sqlite3 "$TARGET" "select coalesce(sum(n),0) from (
  select count(*) n from issues where owner_user_id not in (select id from users)
  union all select count(*) from issues where assignee is not null and assignee like 'user:%' and assignee not in (select id from users)
  union all select count(*) from sessions where owner_user_id not in (select id from users)
  union all select count(*) from issue_user_state where user_id not in (select id from users)
  union all select count(*) from issue_message_user_state where user_id not in (select id from users));")"
if [ "${ORPH:-1}" = "0" ]; then echo "  clean -- the split brain is healed"; else note_fail "$ORPH row(s) still name a user that does not exist"; fi

if [ -n "$REF" ]; then
  say "Check 6/6: schema comparison against the known-good ledger-98 database"
  echo "  reference: $REF"
  dump_master() { sqlite3 "$1" "select type||'|'||name||'|'||replace(coalesce(sql,''),char(10),' ') from sqlite_master where name not like 'sqlite_%' order by type,name;"; }
  dump_cols() {
    sqlite3 "$1" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name;" | while read -r t; do
      sqlite3 "$1" "select '$t|'||cid||'|'||name||'|'||type||'|'||\"notnull\"||'|'||coalesce(quote(dflt_value),'NULL')||'|'||pk from pragma_table_info('$t');"
    done
  }
  dump_idx() {
    sqlite3 "$1" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name;" | while read -r t; do
      sqlite3 "$1" "select '$t|'||il.name||'|unique='||il.\"unique\"||'|origin='||il.origin||'|partial='||il.partial||'|cols='||group_concat(coalesce(ix.name,'<expr>')||':'||ix.desc,',') from pragma_index_list('$t') il join pragma_index_xinfo(il.name) ix where ix.key=1 group by il.name, il.\"unique\", il.origin, il.partial order by il.name;"
    done
  }
  dump_trig() { sqlite3 "$1" "select name||'|'||tbl_name||'|'||replace(sql,char(10),' ') from sqlite_master where type='trigger' order by name;"; }
  for what in master cols idx trig; do
    dump_$what "$TARGET"            > "$WORK/after.$what"
    dump_$what "file:$REF?mode=ro" > "$WORK/ref.$what"
    if diff -q "$WORK/after.$what" "$WORK/ref.$what" >/dev/null; then
      printf '  %-7s IDENTICAL (%s objects)\n' "$what:" "$(wc -l < "$WORK/after.$what")"
    else
      printf '  %-7s DIFFERS\n' "$what:"
      diff "$WORK/after.$what" "$WORK/ref.$what" | head -60
      note_fail "the reverted schema does not match the known-good ledger-98 schema ($what)"
    fi
  done
else
  say "Check 6/6: SKIPPED -- no reference database was given"
  echo "  The result could not be compared against a known-good ledger-98 schema."
  echo "  This is weaker than a normal run. See RUNBOOK.md."
fi

# ----------------------------------------------------------------- verdict --

if [ "$FAILED" != "0" ]; then
  if [ "$APPLY" = "1" ]; then
    abort "the reversal ran, but the checks afterwards did not all pass." \
      "The failures are marked '*** FAILED' above." \
      "" \
      "The reversal itself committed -- it is the CHECKS that failed, so the" \
      "database is now in a state this script cannot vouch for. Do NOT start" \
      "the server on it. Restore the backup using the commands printed above."
  else
    abort "the DRY RUN did not pass all its checks, so do NOT use --apply." \
      "The failures are marked '*** FAILED' above. Your real database was" \
      "never touched -- this was a rehearsal on a throwaway copy." \
      "" \
      "Nothing here is safe to work around on your own. Use the fallback."
  fi
fi

if [ "$APPLY" = "1" ]; then
  say "Folding the write-ahead log back into the database file"
  sqlite3 "$TARGET" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
fi

printf '\n'
rule
if [ "$APPLY" = "1" ]; then
  printf '  ALL CHECKS PASSED. The database is now at ledger 98.\n\n'
  printf '    database : %s\n' "$DB_ABS"
  printf '    backup   : %s\n' "$BACKUP"
  printf '\n  The backup above is the database as it was BEFORE this run. Keep it\n'
  printf '  until you have started the server and confirmed everything is there.\n'
  printf '\n  NEXT: RUNBOOK.md section "DID IT WORK?" -- start the server and check.\n'
else
  printf '  ALL CHECKS PASSED on the dry run. Your real database was NOT touched.\n\n'
  printf '    rehearsed on: %s\n' "$TARGET"
  printf '\n  NEXT: stop the Podium server, then run the same command again with\n'
  printf '  --apply added. RUNBOOK.md has the exact line.\n'
fi
rule
printf '\n  Work directory: %s\n' "$WORK"
[ -n "$KEEP" ] || printf '  (a temporary directory -- delete it with: rm -rf "%s")\n' "$WORK"
printf '\n'
