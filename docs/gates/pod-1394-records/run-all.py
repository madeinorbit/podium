#!/usr/bin/env python3
"""Re-run the whole mutant set at the current candidate, compactly.

Runs mutate.py per mutant, sequentially (one mutant in flight, ever), and prints
one line per mutant. Aborts the whole batch if the tree is dirty at any point.
"""
import json, os, subprocess, sys

S = "/tmp/claude-1000/-home-mgw-src-other-podium--worktrees-issue-1394-multi-user-mutation-probe-campaign/2b785899-f722-429c-b7fb-591cc0b7ad79/scratchpad"
REPO = "/home/mgw/src/other/podium/.worktrees/issue-1394-multi-user-mutation-probe-campaign"
V = ("bun --bun node_modules/vitest/vitest.mjs run --passWithNoTests "
     "--config vitest.unit.config.ts --project node")

PLANES = "packages/protocol/src/planes"
PRES = "apps/server/src/gateway/presence-routing.test.ts"

MUTANTS = [
    # id,            file,                                          edits,   guardrail
    ("C1",  "apps/server/src/gateway/presence-routing.ts", "C1.json",  f"{V} {PRES} {PLANES}"),
    ("C1b", "apps/server/src/relay.ts", "C1b.json",
     f"{V} apps/server/src/browser-open.test.ts apps/server/src/modules/sessions/oracle-decomposition.test.ts"),
    ("C2b", "packages/sync/src/feed/visibility.ts", "C2.json", f"{V} scripts/audit-scoped-feed.test.ts"),
    ("C3a2", "apps/server/src/gateway/client-mux.ts", "C3a2.json", f"{V} apps/server/src/gateway/client-mux.test.ts"),
    ("C3b", "apps/server/src/auth-route.ts", "C3b.json",
     f"{V} apps/server/src/auth-route.test.ts apps/server/src/wsServer.client-auth.test.ts"),
    ("C4a", "packages/sync/src/authority/scoping.ts", "C4a.json", "bun run audit:scoped-feed"),
    ("C4b2", "packages/sync/src/authority/scoping.ts", "C4b2.json", f"{V} scripts/audit-scoped-feed.test.ts"),
    ("C4c", "packages/sync/src/authority/scoping.ts", "C4c.json", f"{V} packages/sync/src/authority"),
    ("C5a", "apps/server/src/machine-access.ts", "C5a.json",
     f"{V} apps/server/src/modules/fleet apps/server/src/machine-access.test.ts apps/server/src/store/grants.test.ts"),
    ("C5b", "apps/server/src/modules/fleet/handlers.ts", "C5b.json", "bun run audit:machine-grants"),
    ("C6a", "packages/protocol/src/planes/stream-port.ts", "C6a.json", f"{V} {PLANES} {PRES}"),
    ("C6b", "packages/protocol/src/planes/stream-port.ts", "C6b.json", f"{V} {PLANES} {PRES}"),
    ("C6c", "apps/server/src/gateway/presence-routing.ts", "C6c.json",
     f"{V} {PRES} apps/server/src/gateway/reattach-storm.integration.test.ts {PLANES}"),
    ("C7a", "apps/server/src/machine-access.ts", "C7a.json",
     f"{V} apps/server/src/modules/fleet apps/server/src/machine-access.test.ts apps/server/src/modules/sessions/handoff"),
    ("C8a2", "packages/sync/src/feed/visibility.ts", "C8a.json", f"{V} packages/sync/src"),
    ("C8b", "packages/model/src/aggregates/registry.ts", "C8b.json",
     f"{V} packages/model/src/aggregates packages/model/src/representations"),
    ("C9a", "apps/server/src/command-principal.ts", "C9a.json",
     f"{V} apps/server/src/authz-matrix.test.ts apps/server/src/modules/issues/service/addComment-principal.test.ts"),
    ("C9b", "apps/server/src/command-principal.ts", "C9b.json",
     f"{V} apps/server/src/authz-matrix.test.ts apps/server/src/modules/issues/service/addComment-principal.test.ts"),
    ("C10", "apps/server/src/migrations/schema.ts", "C10.json", "bun run audit:rearch"),
]

only = sys.argv[1:] or None
env = dict(os.environ)
env["MUT_OUT"] = f"{S}/records2"
env["PODIUM_STATE_DIR"] = f"{S}/state"

print(f"{'id':<8}{'exit':<6}{'result':<12}{'file:line':<52}note")
print("-" * 110)
for mid, path, edits, cmd in MUTANTS:
    if only and mid not in only:
        continue
    p = subprocess.run(
        ["python3", f"{S}/mutate.py", "--id", mid, "--file", path,
         "--edits", f"{S}/edits/{edits}", "--cmd", cmd, "--timeout", "900"],
        capture_output=True, text=True, cwd=REPO, env=env)
    rec_path = f"{S}/records2/mutant-{mid}.json"
    if p.returncode != 0 or not os.path.exists(rec_path):
        tail = (p.stdout + p.stderr).strip().splitlines()
        note = tail[-1][:70] if tail else "?"
        print(f"{mid:<8}{'--':<6}{'ABORT':<12}{path[:50]:<52}{note}")
        continue
    r = json.load(open(rec_path))
    e = r["edits"][0]
    res = "CAUGHT" if r["exit_code"] != 0 else "SURVIVED"
    ok = r["restored_identical"] and r["git_clean_after"]
    note = "" if ok else "!! RESTORE PROBLEM"
    print(f"{mid:<8}{r['exit_code']:<6}{res:<12}{(path+':'+str(e['anchor_line']))[:50]:<52}{note}")
