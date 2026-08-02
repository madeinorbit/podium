import json, os, subprocess, sys
S = os.path.dirname(os.path.abspath(__file__))
REPO = "/home/mgw/src/other/podium/.worktrees/issue-1394-multi-user-mutation-probe-campaign"
V = ("bun --bun node_modules/vitest/vitest.mjs run --passWithNoTests "
     "--config vitest.unit.config.ts --project node")
M = [
 ("N1","packages/sync/src/feed/identity.ts","N1.json",f"{V} packages/sync/src/feed"),
 ("N2","apps/server/src/command-principal.ts","N2.json",
  f"{V} apps/server/src/authz-matrix.test.ts apps/server/src/machine-access.test.ts packages/model/src/identity"),
 ("N3","packages/protocol/src/planes/control-port.ts","N3.json",f"{V} packages/protocol/src/planes"),
 ("N4","packages/model/src/annotations/matrix.ts","N4.json",f"{V} packages/model/src/annotations"),
 ("N5","packages/model/src/annotations/ownership.ts","N5.json",f"{V} packages/model/src/annotations"),
]
env = dict(os.environ); env["MUT_OUT"]=f"{S}/records2"; env["PODIUM_STATE_DIR"]=f"{S}/state"
print(f"{'id':<6}{'exit':<6}{'result':<11}{'file:line':<50}")
print("-"*95)
for mid, path, edits, cmd in M:
    p = subprocess.run(["python3", f"{S}/mutate.py","--id",mid,"--file",path,
        "--edits",f"{S}/edits/{edits}","--cmd",cmd,"--timeout","900"],
        capture_output=True, text=True, cwd=REPO, env=env)
    rp=f"{S}/records2/mutant-{mid}.json"
    if p.returncode!=0 or not os.path.exists(rp):
        t=(p.stdout+p.stderr).strip().splitlines()
        print(f"{mid:<6}{'--':<6}{'ABORT':<11}{path[:48]:<50}{t[-1][:60] if t else ''}"); continue
    r=json.load(open(rp)); e=r["edits"][0]
    res="CAUGHT" if r["exit_code"]!=0 else "SURVIVED"
    warn="" if (r["restored_identical"] and r["git_clean_after"]) else " !! RESTORE"
    print(f"{mid:<6}{r['exit_code']:<6}{res:<11}{(path+':'+str(e['anchor_line']))[:48]:<50}{warn}")
