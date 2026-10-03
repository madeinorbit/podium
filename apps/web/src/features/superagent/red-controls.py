"""Planted controls for the new Superagent checks, on the flatblock checkout.

Run with the checkout .toolchain on PATH. Every plant is copied aside, tested
through test:file, and restored even on failure. No shared/core files change.
The visibility plant intentionally regresses the 0-before-attach cursor freeze.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

root = Path(__file__).resolve().parents[5]
os.chdir(root)
out = root / ".artifacts/superagent/controls"
out.mkdir(parents=True, exist_ok=True)
source = "packages/client-graph/src/superagent.ts"
graph_test = "packages/client-graph/src/superagent.test.ts"
web = "apps/web/src/features/superagent/"
phone = "apps/mobile/src/screens/"

# id, owning implementation, exact plant, focused test, title fragment.
cases = [
    ("active", source, "row.id === local.superThreadId", "row.id === 'global'", graph_test, "declares private threads"),
    ("private", source, "if (!catalog.ids.includes(id))", "if (false)", graph_test, "never addresses an unlisted"),
    ("identity", source, "if (next === this.previousThreads) return", "if (false) return", graph_test, "keeps unrelated publications"),
    ("numeric", source, "(a, b) => a.eventId - b.eventId", "(a, b) => String(a.eventId).localeCompare(String(b.eventId))", graph_test, "orders numeric event ids"),
    ("cursor", source, "if (this.demanded.has('cursor')) this.schedule()", "if (false) this.schedule()", graph_test, "borrows the per-principal"),
    ("question-order", source, "ids: replica.rows('pendingInteractions').map(row => row.id)", "ids: replica.rows('pendingInteractions').map(row => row.id).sort()", graph_test, "reuses notice payloads"),
    ("cold-index", source, "this.previousThreads = next;", "replica.rows('sessions'); this.previousThreads = next;", graph_test, "batches addressed cold session"),
    ("dispose", source, "for (const stop of this.stops) stop()", "for (const stop of []) stop()", graph_test, "releases all scoped state"),
    ("differential", "packages/client-graph/diagnostics/superagent-check.ts", "differences: result.differences", "differences: 0", graph_test, "reports planted errors"),
    ("device-latch", web + "data-layer.ts", "screen.initialize(ui)", "screen.initialize({ get: () => null })", web + "data-layer.test.ts", "defaults off and latches"),
    ("check-switch", web + "data-layer.ts", "screen.checkRequested", "() => false", web + "data-layer.test.ts", "uses the shared pilot preference"),
    ("divider-attach", web + "useIssueEvents.ts", "if (visible && !wasVisible.current) setDivider(readPosition.get('issueEvents'))\n    wasVisible.current = visible", "if (visible && !loading && !wasVisible.current) setDivider(cursor)\n    wasVisible.current = visible && !loading", web + "SuperagentView.pool.test.tsx", "renders the same thread"),
    ("web-publisher", web + "use-superagent-inputs.ts", "? usePoolThread : useLegacyThread", "? useLegacyThread : useLegacyThread", web + "SuperagentView.pool.test.tsx", "executes zero legacy"),
    ("web-owner", web + "SuperagentView.tsx", "await trpc.superagent.clear.mutate({ threadId: THREAD_ID })", "await Promise.resolve()", web + "SuperagentView.pool.test.tsx", "keeps the existing mutation"),
    ("phone-context", phone + "SuperagentScreen.tsx", "pool.sessionPanes.session(id)", "undefined", phone + "SuperagentScreen.pool.test.tsx", "renders the same phone session"),
    ("phone-publisher", phone + "SuperagentScreen.tsx", "? usePoolSuperagent : useLegacySuperagent", "? useLegacySuperagent : useLegacySuperagent", phone + "SuperagentScreen.pool.test.tsx", "has zero legacy thread"),
    ("phone-owner", phone + "SuperagentScreen.tsx", "onSend={send}", "onSend={() => {}}", phone + "SuperagentScreen.pool.test.tsx", "keeps sending and clearing"),
    ("phone-startup", "apps/mobile/src/client/mobile-pool.ts", "return { host, initialize: (ui) => void pilot.initialize(ui)", "return { host, initialize: (_ui) => {}", phone + "SuperagentScreen.pool.test.tsx", "renders the same phone session"),
    ("ensure-reuse", "packages/client-graph/src/source-registry.ts", "return existing.promise as Promise<PoolSource<E>>", "return Promise.resolve(create())", "packages/client-graph/src/superagent-registration.test.ts", "reuses one pending factory"),
    ("ensure-owner", "packages/client-graph/src/source-registry.ts", "if (entities.some(entity => this.byEntity.has(entity) || this.owners.has(entity)))", "if (false)", "packages/client-graph/src/superagent-registration.test.ts", "rejects a different key"),
    ("ensure-declaration", "packages/client-graph/src/source-registry.ts", "if (entities.length !== existing.entities.length || entities.some(entity => !existing.entities.includes(entity)))", "if (false)", "packages/client-graph/src/superagent-registration.test.ts", "rejects a changed or duplicate"),
    ("ensure-dispose", "packages/client-graph/src/source-registry.ts", "if (this.disposed || new Set(entities).size !== entities.length ||\n      entities.some", "if (new Set(entities).size !== entities.length ||\n      entities.some", "packages/client-graph/src/superagent-registration.test.ts", "disposes a late factory"),
    ("ensure-retry", "packages/client-graph/src/source-registry.ts", "this.ensured.delete(key)", "void key", "packages/client-graph/src/superagent-registration.test.ts", "releases a failed factory"),
]

reports = []
for key, file, before, after, test, title in cases:
    while float(Path("/proc/loadavg").read_text().split()[0]) > 8:
        print(f"{key}: waiting for flatblock load admission", flush=True)
        time.sleep(10)
    path = root / file
    original = path.read_bytes()
    text = original.decode()
    if text.count(before) != 1:
        raise RuntimeError(f"{key}: plant no longer matches exactly once")
    backup = out / (key + ".backup")
    subprocess.run(["cp", path, backup], check=True)
    try:
        path.write_text(text.replace(before, after, 1))
        result = subprocess.run(["bun", "run", "test:file", "--", test, "-t", title],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        (out / (key + ".log")).write_bytes(result.stdout)
        clean = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout.decode(errors="replace"))
        failed = re.search(r"Tests\s+([1-9][0-9]*) failed", clean)
        rejected = result.returncode != 0 and failed is not None
        reports.append({"control": key, "test": test, "exit": result.returncode,
                        "rejected": rejected, "failedTests": int(failed[1]) if failed else 0})
        print(json.dumps(reports[-1]), flush=True)
    finally:
        subprocess.run(["cp", backup, path], check=True)
        backup.unlink()
        if hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(original).digest():
            raise RuntimeError(f"{key}: restore failed")
    (out / "summary.json").write_text(json.dumps(reports, indent=2))
    if not rejected:
        raise RuntimeError(f"{key}: planted control did not fail a collected test")

print(f"All {len(reports)} planted controls rejected; source bytes restored", flush=True)
