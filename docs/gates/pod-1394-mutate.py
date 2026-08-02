#!/usr/bin/env python3
"""POD-1394 mutation runner.

One mutant per invocation. Enforces, in order:
  1. tree clean (git status --porcelain empty)
  2. anchor occurs EXACTLY once in the target file
  3. apply; assert file hash MOVED and the replacement text is present (grep-back)
  4. run the guardrail command; capture exit code + output
  5. restore original bytes; assert hash back to original, anchor count back to
     original, and git status clean again

Any violation aborts loudly. A mutant that never applied otherwise produces a
GREEN that reads exactly like a guardrail working.

Usage:
  mutate.py --id C1a --file <path> --anchor-file <f> --replace-file <f> \
            --cmd '<shell>' [--timeout 600] [--expect-exit nonzero|zero]
"""
import argparse, hashlib, json, os, subprocess, sys, time

REPO = os.environ.get("REPO_ROOT") or subprocess.run(
    ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
).stdout.strip()


def sh(cmd, timeout=None, cwd=REPO):
    t0 = time.time()
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                       cwd=cwd, timeout=timeout)
    return p.returncode, p.stdout + p.stderr, time.time() - t0


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def git_dirty():
    return sh("git status --porcelain")[1].strip()


def die(msg):
    print(f"\n!! ABORT: {msg}", file=sys.stderr)
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--anchor-file")
    ap.add_argument("--replace-file")
    ap.add_argument("--edits", help="JSON file: [{anchor, replace}, ...] — ONE mutant, "
                                    "applied atomically; each anchor must match exactly once")
    ap.add_argument("--cmd", required=True)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    target = os.path.join(REPO, args.file)
    if args.edits:
        edits = json.load(open(args.edits))
    else:
        edits = [{"anchor": open(args.anchor_file).read(),
                  "replace": open(args.replace_file).read()}]

    rec = {"id": args.id, "file": args.file, "cmd": args.cmd,
           "candidate_sha": sh("git rev-parse HEAD")[1].strip()}

    # --- 1. clean tree -----------------------------------------------------
    dirty = git_dirty()
    if dirty:
        die(f"tree not clean before mutation:\n{dirty}")

    original = open(target, "rb").read()
    orig_hash = hashlib.sha256(original).hexdigest()
    orig_text = original.decode("utf-8")
    rec["original_sha256"] = orig_hash

    # --- 2. anchor count EXACTLY 1 (per edit) -----------------------------
    rec["edits"] = []
    for e in edits:
        count = orig_text.count(e["anchor"])
        line_no = (orig_text[: orig_text.index(e["anchor"])].count("\n") + 1) if count else None
        rec["edits"].append({"anchor_count_before": count, "anchor_line": line_no,
                             "anchor_first_line": e["anchor"].strip().splitlines()[0][:120]})
        if count != 1:
            die(f"anchor {e['anchor'].strip().splitlines()[0][:80]!r} matches "
                f"{count} times in {args.file}, expected exactly 1")
        print(f"[{args.id}] anchor found exactly once at {args.file}:{line_no}")

    try:
        # --- 3. apply + grep-back -----------------------------------------
        mutated_text = orig_text
        for e in edits:
            mutated_text = mutated_text.replace(e["anchor"], e["replace"], 1)
        with open(target, "w") as f:
            f.write(mutated_text)
        new_hash = sha256(target)
        rec["mutated_sha256"] = new_hash
        if new_hash == orig_hash:
            die("file hash did NOT move after applying the mutant")
        back = open(target).read()
        for i, e in enumerate(edits):
            repl, anch = e["replace"], e["anchor"]
            if repl.strip() == "":
                # A DELETION. `"" in text` is vacuously true, so the only
                # meaningful grep-back is that the anchor is now ABSENT.
                present = anch not in back
                rec["edits"][i]["grep_back_kind"] = "deletion: anchor absent"
                rec["edits"][i]["grep_back_probe"] = anch.strip().splitlines()[0][:120]
            else:
                present = repl in back and (anch not in back or anch in repl)
                rec["edits"][i]["grep_back_kind"] = "replacement present"
                rec["edits"][i]["grep_back_probe"] = repl.strip().splitlines()[0][:120]
            rec["edits"][i]["grep_back_present"] = present
            if not present:
                die(f"grep-back FAILED for edit {i} ({rec['edits'][i]['grep_back_kind']})")
        print(f"[{args.id}] mutant applied: {orig_hash[:12]} -> {new_hash[:12]}; "
              f"grep-back OK for all {len(edits)} edit(s)")

        # --- 4. run the guardrail -----------------------------------------
        print(f"[{args.id}] running guardrail: {args.cmd}")
        try:
            code, out, elapsed = sh(args.cmd, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            code, out, elapsed = -1, "<<TIMEOUT>>", args.timeout
        rec["exit_code"] = code
        rec["elapsed_s"] = round(elapsed, 1)
        rec["output"] = out[-20000:]
        print(f"[{args.id}] guardrail exit={code} in {elapsed:.1f}s")
    finally:
        # --- 5. restore + byte identity -----------------------------------
        with open(target, "wb") as f:
            f.write(original)
        restored_hash = sha256(target)
        rec["restored_sha256"] = restored_hash
        rec["restored_identical"] = restored_hash == orig_hash
        restored_text = open(target).read()
        for i, e in enumerate(edits):
            recount = restored_text.count(e["anchor"])
            rec["edits"][i]["anchor_count_after"] = recount
            if recount != 1:
                die(f"RESTORE FAILED: edit {i} anchor count {recount} != 1")
        dirty_after = git_dirty()
        rec["git_clean_after"] = dirty_after == ""
        if restored_hash != orig_hash:
            die("RESTORE FAILED: hash does not match the original")
        if dirty_after:
            die(f"RESTORE FAILED: git status not clean:\n{dirty_after}")
        print(f"[{args.id}] restored: sha256 {restored_hash[:12]} identical, "
              f"every anchor count back to 1, git status clean")

    out_path = args.out or os.path.join(
        os.environ.get("MUT_OUT", "/tmp"), f"mutant-{args.id}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(rec, f, indent=2)
    print(f"[{args.id}] record -> {out_path}")

    tail = "\n".join(rec["output"].splitlines()[-40:])
    print(f"\n----- guardrail output (tail) -----\n{tail}\n-----------------------------------")


if __name__ == "__main__":
    main()
