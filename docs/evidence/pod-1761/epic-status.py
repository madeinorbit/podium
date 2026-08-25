#!/usr/bin/env python3
"""Compute POD-1761's true state from evidence, not from memory.

Twice in one session the coordinator concluded "there is nothing there" after
looking in the wrong place: mail claimed on the wrong inboxes, and reviewer
verdicts sought in issue COMMENTS when every verdict on this epic arrives as
MAIL. Both were survivable. The class is not — a coordinator who surveys by
hand surveys differently each time, and the difference is invisible.

So the survey is a program. It joins three sources that nobody holds together
in their head:

  * `podium issue tree`  — every child, its stage, and its live sessions
  * git                  — has the child's branch actually landed on the epic
  * the epic's MAIL      — the newest verdict, because verdicts live nowhere else

and prints the three lists a sweep acts on:

  CLOSABLE    landed, newest verdict clean, nothing alive       -> close it
  STALLED     newest verdict is fix-needed and nobody is on it  -> where the epic rots
  NO VERDICT  in review with no verdict at all                  -> needs a reviewer

Run it FIRST in every sweep, before starting anything new.

  python3 docs/evidence/pod-1761/epic-status.py [--refresh]

--refresh re-pulls the tree and the epic inbox (~2 min); otherwise the last
pull under /tmp is reused. A stale cache can only make the picture look WORSE
than it is (older verdicts, unlanded branches), never better, so a cached run
is safe to act on downward.
"""
import os, re, subprocess, sys, tempfile

EPIC, BRANCH = "1761", "issue/1761-agent-runtime"
CACHE = os.path.join(tempfile.gettempdir(), "pod1761-status")

# Direction is read from the reviewer's PROSE: no field records it. Order
# matters — "the earlier fix-needed is now CLEAN" must read as clean, so the
# clean pattern is tried first only when it dominates the line. Anything
# unreadable prints '?', which is NOT the same as clean and never closes.
FIX = re.compile(r"(?i)(fix.needed|changes (required|requested)|send.back|reject|"
                 r"do not (close|land|merge)|not clean|blocked|red /)")
CLEAN = re.compile(r"(?i)(clean|pass\b|ship|land as|land it|no blocking|accept)")


def run(args, cwd, timeout=300):
    return subprocess.run(args, capture_output=True, text=True, cwd=cwd, timeout=timeout).stdout


def capture(args, cwd, dest, timeout=300):
    """Run a podium command with its stdout REDIRECTED TO A FILE, not piped.

    Piping truncates it. Captured through a pipe, `mail inbox` came back at
    exactly 98304 bytes and `issue tree` at exactly 65536 — power-of-two cuts,
    the signature of a process exiting before its async pipe writes flush. The
    same commands redirected to a file are complete. A survey silently missing
    its tail is worse than no survey: every truncated child reads as "no
    verdict", which is the same shape as the mistake this script exists to
    stop.
    """
    with open(dest, "w") as fh:
        r = subprocess.run(args, stdout=fh, stderr=subprocess.PIPE, text=True,
                           cwd=cwd, timeout=timeout)
    # An empty capture is a REFUSED COMMAND, not an empty epic. Swallowing the
    # stderr once turned "--max-nodes above its ceiling" into "0 children".
    if r.returncode != 0 or os.path.getsize(dest) == 0:
        raise SystemExit(f"{' '.join(args)} produced nothing: {r.stderr.strip()[:200]}")


def refresh(repo):
    os.makedirs(CACHE, exist_ok=True)
    capture(["podium", "issue", "tree", EPIC, "--max-nodes", "1000"], repo, f"{CACHE}/tree.txt")
    capture(["podium", "issue", "mail", "inbox", EPIC], repo, f"{CACHE}/inbox.txt")


def children():
    """(ref, stage, title, live-sessions) for every child, from the tree.

    The child list is the system's own. A list the coordinator keeps by hand is
    a list that goes stale without saying so.
    """
    out, cur = [], None
    for line in open(f"{CACHE}/tree.txt", errors="replace"):
        m = re.match(r"^\s+#(\d+) \S+ \[(\w+)\] (.*?)(?: — |$)", line)
        if m:
            cur = [m.group(1), m.group(2), m.group(3).strip(), []]
            out.append(cur)
            continue
        s = re.match(r"^\s+session (\S+) .*?(working|hibernated|exited|errored|blocked)\b", line)
        if s and cur and s.group(2) != "exited":
            cur[3].append(s.group(2))
    return out


def verdicts():
    """Newest verdict line per sending issue: (timestamp, direction, line)."""
    txt = open(f"{CACHE}/inbox.txt", errors="replace").read()
    p = re.split(r"(?m)^\s{2}(msg_[0-9a-f-]{36}) (\S+) (\S+)", txt)
    out = {}
    for i in range(1, len(p), 4):
        sender, ts, body = p[i + 1], p[i + 2], p[i + 3]
        m = re.match(r"issue:#(\d+)", sender)
        if not m:
            continue
        # Take the most DECISIVE line in the message, not the last one that
        # happens to contain the word. Reviewers use "verdict" in ordinary
        # prose ("my earlier verdict", "before the verdict") and a
        # last-match-wins rule reports those as unreadable while a real
        # FIX-NEEDED headline sits two paragraphs above.
        best = None
        for line in re.findall(r"(?i)[^\n]*verdict[^\n]*", body):
            d = "FIX" if FIX.search(line) else ("CLEAN" if CLEAN.search(line) else "?")
            rank = {"FIX": 2, "CLEAN": 1, "?": 0}[d]
            if best is None or rank > best[0]:
                best = (rank, d, line.strip()[:90])
        if best and (m.group(1) not in out or ts >= out[m.group(1)][0]):
            out[m.group(1)] = (ts, best[1], best[2])
    return out


def landed(repo, num):
    br = run(["git", "branch", "--list", f"issue/{num}-*", "--format=%(refname:short)"],
             repo, 30).split("\n")[0].strip()
    if not br:
        return "no-branch"
    if subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", br, BRANCH],
                      capture_output=True).returncode == 0:
        return "landed"
    return "ahead+" + run(["git", "rev-list", "--count", f"{BRANCH}..{br}"], repo, 30).strip()


def main():
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if "--refresh" in sys.argv or not os.path.isdir(CACHE):
        print("refreshing tree + inbox …", file=sys.stderr)
        refresh(repo)

    vs, kids = verdicts(), children()
    openk = [k for k in kids if k[0] != EPIC and k[1] not in ("done", "proposed")]
    print(f"POD-1761 — {len(kids)} children, {len(openk)} open\n")
    print(f"{'ref':<9}{'stage':<13}{'branch':<11}{'verdict':<8}{'when':<12}{'live':<10}title")

    closable, stalled, unowned, moving = [], [], [], []
    for num, stage, title, live in sorted(openk, key=lambda k: int(k[0])):
        land, v = landed(repo, num), vs.get(num)
        vd, wh = (v[1], v[0][:10]) if v else ("none", "-")
        # HIBERNATED IS NOT ALIVE. A parked session looks like an owner and is
        # not one: it will never act again unless someone wakes it. Counting it
        # as "moving" is how work sits in review for days with an apparent owner.
        working = [x for x in live if x == "working"]
        lv = ("working" if working else ("parked x%d" % len(live)) if live else "-")
        print(f"POD-{num:<5}{stage:<13}{land:<11}{vd:<8}{wh:<12}{lv:<10}{title[:40]}")
        if working:
            moving.append(num)
        elif stage == "review" and land == "landed" and vd == "CLEAN":
            closable.append(num)
        elif vd == "FIX":
            stalled.append(num)
        elif stage == "review" and vd in ("none", "?"):
            unowned.append(num)

    for label, ns, why in (
        ("CLOSABLE", closable, "landed, newest verdict clean, nothing alive — close it"),
        ("STALLED", stalled, "newest verdict is fix-needed and NOBODY is on it — the epic rots here"),
        ("NO VERDICT", unowned, "in review, no readable verdict in the epic inbox — needs a reviewer"),
        ("MOVING", moving, "a session is actually WORKING; leave it alone"),
    ):
        print(f"\n## {label} ({len(ns)}) — {why}")
        print("   " + (" ".join("POD-" + x for x in ns) if ns else "none"))
    print("\n'?' means the verdict line was unreadable. That is NOT clean, and it never closes.")
    print("Direction is biased toward FIX on purpose: a message carrying both a fix-needed")
    print("headline and a clean one reads as FIX, so 'my earlier fix-needed is now CLEAN'")
    print("lands in STALLED for a human to confirm. This tool must never close something")
    print("on its own reading of prose — it decides what to LOOK at, never what is done.")


if __name__ == "__main__":
    main()
