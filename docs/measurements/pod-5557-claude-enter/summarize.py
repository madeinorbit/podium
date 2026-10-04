"""Audit the saved PTY evidence; this is measurement analysis, not a repo test."""
import collections
import datetime
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
BASELINE = {
    "2.1.283-idle-probe.jsonl": 15,
    "2.1.283-busy.jsonl": 30,
    "2.1.283-compacting-corrected.jsonl": 15,
    "2.1.283-load.jsonl": 45,
    "2.1.283-compacting-load.jsonl": 15,
    "2.1.289-normal.jsonl": 60,
    "2.1.289-load.jsonl": 60,
}
SUPPLEMENT = {(r["file"], r["case"]): r["records"] for r in
              (json.loads(line) for line in (HERE / "settled-transcripts.jsonl").read_text().splitlines())}


def content(record):
    if record["type"] == "user":
        value = record["message"]["content"]
        if isinstance(value, list):
            return "\n".join(block.get("text", "") for block in value)
        return value
    if record["type"] == "attachment":
        return record.get("attachment", {}).get("prompt", "")
    return record.get("content", "")


def unframe(value):
    return re.sub(r"</?pasted_content id=\"[^\"]+\">\n?", "", value).strip()


def read(name):
    rows = [json.loads(line) for line in (HERE / name).read_text().splitlines()]
    for row in rows:
        row["final"]["records"].extend(SUPPLEMENT.get((name, row["case"]), []))
    return rows


def epoch(record):
    return datetime.datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00")).timestamp() * 1000


def audit(row, require_native=False):
    actual = row["text"].strip()
    records = row["final"]["records"]
    native = [r for r in records if r["type"] in ("user", "attachment")]
    assert (len(native) == 1 if require_native else len(native) <= 1), (row["case"], "native prompt count", len(native))
    for record in native:
        assert unframe(content(record)) == actual, (row["case"], "merged or altered prompt")
    enqueues = [r for r in records if r["type"] == "queue-operation" and r["operation"] == "enqueue"]
    assert len(enqueues) <= 1, (row["case"], "duplicate queue")
    assert native or enqueues, (row["case"], "no native proof")
    for record in enqueues:
        assert unframe(content(record)) == actual, (row["case"], "merged queue")
    pastes = [w for w in row["final"]["writes"] if w["bytes"].startswith("\x1b[200~")]
    assert len(pastes) == 1, (row["case"], "paste count", len(pastes))
    assert pastes[0]["bytes"] == "\x1b[200~" + row["text"] + "\x1b[201~"
    return native, enqueues


baseline = []
for name, count in BASELINE.items():
    rows = read(name)
    assert len(rows) == count, (name, len(rows), count)
    for row in rows:
        audit(row)
        assert row.get("fault", "none") == "none"
    baseline.extend(rows)

cells = collections.Counter((r["version"], r["load"], r["state"], r["body"], r["delay"]) for r in baseline)
assert len(cells) == 240 and set(cells.values()) == {1}
lagged = []
for row in baseline:
    if not row["firstCRSubmitted"]:
        first = next(w for w in row["final"]["writes"] if w["bytes"] == "\r")
        record = next(r for r in row["final"]["records"] if r["type"] in ("user", "attachment"))
        recovery = next(w for w in row["final"]["writes"] if w["origin"] == "recovery")
        assert epoch(record) < recovery["at"]
        assert row["beforeRecovery"]["screen"].get("inputDraft") == ""
        lagged.append({"case": row["case"], "firstCR": first["at"], "recorded": epoch(record), "manualCR": recovery["at"]})

coalesced = read("2.1.283-coalesced.jsonl")
for row in coalesced:
    audit(row)
    assert row["firstCRSubmitted"]

groups = []
for version in ("2.1.283", "2.1.289"):
    for load in (False, True):
        selected = [r for r in baseline if r["version"] == version and r["load"] == load]
        groups.append({"version": version, "load": load, "cases": len(selected), "submitted": len(selected),
                       "nativeRecords": collections.Counter(r["type"] for x in selected for r in x["final"]["records"] if r["type"] in ("user", "attachment"))})

faults = []
for path in sorted(HERE.glob("*-missed-enter-*.jsonl")):
    rows = read(path.name)
    for row in rows:
        audit(row, require_native="-after" in path.name)
    faults.append({"file": path.name, "cases": len(rows), "verifiedBeforeManualRecovery": sum(r["firstCRSubmitted"] for r in rows),
                   "singlePastePerCase": True,
                   "messageCRCounts": dict(collections.Counter(sum(w["bytes"] == "\r" and w["origin"] == "message" for w in r["final"]["writes"]) for r in rows))})

summary = {"baselineCases": len(baseline), "baselineSubmitted": len(baseline), "groups": groups,
           "proofSnapshotLag": lagged, "coalescedCases": len(coalesced), "coalescedSubmitted": len(coalesced),
           "observedDelayRanges": {str(delay): [min(r["observedDelay"] for r in baseline if r["delay"] == delay), max(r["observedDelay"] for r in baseline if r["delay"] == delay)] for delay in (0, 30, 90, 200, 500)},
           "faults": faults}
(HERE / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
