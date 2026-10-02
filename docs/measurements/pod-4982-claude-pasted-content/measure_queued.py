#!/usr/bin/env python3
"""Queued-paste measurement for POD-5269.

Paste while Claude is busy, so the prompt goes through `queue-operation`
enqueue and is recorded TRIMMED (no leading/trailing separator LFs).

Method mirrors measure.py: real Claude TUI, scratch HOME, localhost fake
model, no inherited credentials. Busy via SLOWTEXT (20 words x 500ms = ~10s
streaming, no tools needed). While busy, bracketed-paste a long input known
to wrap when idle (4+ lines, ~950 chars like the live 944-char failure, but
synthetic text -- never the user's message).

Saves claude-<version>-gate-on-queued.jsonl with {case, input, record, enqueue}.
`record` is the subsequent `user` record (or queued_command attachment when
the turn merges), `enqueue` is the queue-operation record.
"""
import argparse
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import time


HERE = Path(__file__).resolve().parent
FAKE = HERE.parent / "pod-4834-receipt-proof/fake-model-server.ts"
KEY = "fake-key-for-the-local-fake-server-not-a-credential"

# Synthetic queued input: 4+ lines and ~950 chars to trigger the paste gate,
# distinct from every existing case and never the live user's text.
QUEUED_INPUT = (
    "queued-paste first line\n"
    "queued-paste second line\n"
    "queued-paste third line\n"
    "queued-paste fourth line\n"
    + "q" * 860
)
BUSY_PROMPT = "SLOWTEXT please stream slowly for the queued measurement"


def run(version, port):
    binary = Path(f"/home/mgw/.local/share/claude/versions/{version}")
    scratch = Path(tempfile.mkdtemp(prefix=f"pod5269-{version}-"))
    work = scratch / "work"
    cfg = scratch / "home/.claude"
    work.mkdir()
    cfg.mkdir(parents=True)
    (cfg / "settings.json").write_text(json.dumps({"permissions": {"allow": []}}))
    (cfg / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True,
        "theme": "dark",
        "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []},
        "cachedGrowthBookFeatures": {"tengu_virtual_pancake": True},
        "projects": {str(work): {
            "hasTrustDialogAccepted": True,
            "hasCompletedProjectOnboarding": True,
            "allowedTools": [],
        }},
    }))
    env = {
        "PATH": os.environ["PATH"], "HOME": str(scratch / "home"),
        "SHELL": "/bin/bash", "TERM": "xterm-256color", "LANG": "C.UTF-8",
        "CLAUDE_CONFIG_DIR": str(cfg), "ANTHROPIC_API_KEY": KEY,
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "CLAUDE_CODE_MAX_RETRIES": "0", "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": "1",
    }
    with socket.socket() as check:
        check.bind(("127.0.0.1", port))
    bun = subprocess.check_output(["mise", "which", "bun"], text=True).strip()
    fake_env = {**env, "FAKE_PORT": str(port), "FAKE_LOG": str(scratch / "requests.jsonl")}
    fake_out = (scratch / "fake.log").open("w")
    fake = subprocess.Popen([bun, str(FAKE)], env=fake_env, stdout=fake_out, stderr=fake_out)
    tmux_socket = f"pod5269-{version}-{os.getpid()}"

    def tmux(*args, capture=False):
        return subprocess.run(["tmux", "-L", tmux_socket, *args], env=env,
                              check=True, capture_output=capture, text=True)

    def screen():
        return tmux("capture-pane", "-p", "-t", "cli", capture=True).stdout

    def all_records():
        out = []
        for path in (cfg / "projects").rglob("*.jsonl"):
            if "subagents" in path.parts:
                continue
            for line in path.read_text().splitlines():
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                out.append(rec)
        return out

    def wait_until(predicate, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.2)
        raise RuntimeError(f"Timed out; scratch={scratch}\n{screen()}")

    try:
        time.sleep(0.4)
        tmux("new-session", "-d", "-s", "cli", "-x", "180", "-y", "45",
             "-c", str(work), f"exec {shlex.quote(str(binary))} --model claude-sonnet-4-6")
        wait_until(lambda: "bypass permissions" in screen() or "❯" in screen())
        (scratch / "screen-start.txt").write_text(screen())

        # 1. Busy prompt via paced typing (short, no wrapper), Enter, do NOT wait.
        for c in BUSY_PROMPT:
            tmux("send-keys", "-t", "cli", "-l", c)
            time.sleep(0.012)
        time.sleep(0.2)
        tmux("send-keys", "-t", "cli", "Enter")
        # Wait for busy indicator (streaming text).
        wait_until(lambda: "esc to interrupt" in screen().lower(), timeout=25)
        (scratch / "screen-busy.txt").write_text(screen())
        busy_at = time.time()

        # Snapshot transcript size before queueing.
        before_recs = all_records()
        before_n = len(before_recs)

        # 2. While busy, bracketed-paste the long input + Enter (queues).
        paste_file = scratch / "queued.txt"
        paste_file.write_text(QUEUED_INPUT)
        tmux("load-buffer", "-b", "queued", str(paste_file))
        tmux("paste-buffer", "-p", "-b", "queued", "-t", "cli")
        time.sleep(0.3)
        tmux("send-keys", "-t", "cli", "Enter")
        enqueue_at = time.time()

        # 3. Wait for the enqueue record carrying (part of) our queued text.
        def find_enqueue():
            for rec in all_records()[before_n:]:
                if rec.get("type") == "queue-operation" and rec.get("operation") == "enqueue":
                    content = rec.get("content", "")
                    if isinstance(content, str) and ("queued-paste" in content or "pasted_content" in content):
                        return rec
            return None

        enqueue = wait_until(find_enqueue, timeout=25)

        # 4. Wait for idle (both turns done), then find the recorded prompt.
        wait_until(lambda: "esc to interrupt" not in screen().lower(), timeout=60)
        time.sleep(1.0)
        (scratch / "screen-final.txt").write_text(screen())

        fresh = all_records()[before_n:]
        # Candidate user records after enqueue (exclude the busy prompt itself).
        user_recs = [
            r for r in fresh
            if r.get("type") == "user" and isinstance((r.get("message") or {}).get("content"), str)
            and "queued-paste" in str((r.get("message") or {}).get("content"))
        ]
        queued_cmds = [
            r for r in fresh
            if isinstance(r.get("attachment"), dict)
            and r["attachment"].get("type") == "queued_command"
            and "queued-paste" in str(r["attachment"].get("prompt", ""))
        ]
        # Also check array-content user records (text blocks) for the paste.
        for r in fresh:
            if r.get("type") == "user":
                msg = r.get("message") or {}
                content = msg.get("content")
                if isinstance(content, list):
                    texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                    if any("queued-paste" in t for t in texts):
                        user_recs.append(r)

        record = user_recs[0] if user_recs else (queued_cmds[0] if queued_cmds else None)
        if record is None:
            print(json.dumps({
                "version": version, "error": "no queued record found",
                "fresh_types": [(r.get("type"), r.get("operation") or (r.get("attachment") or {}).get("type") if isinstance(r.get("attachment"), dict) else r.get("subtype")) for r in fresh],
            }, ensure_ascii=False))
            print(f"scratch={scratch}", flush=True)
            return

        row = {
            "case": "queued-paste-944",
            "mode": "queued-paste",
            "paste_tags": True,
            "input": QUEUED_INPUT,
            "busy_prompt": BUSY_PROMPT,
            "record": record,
            "enqueue": enqueue,
            "busy_at": busy_at,
            "enqueue_at": enqueue_at,
        }
        out_path = HERE / f"claude-{version}-gate-on-queued.jsonl"
        out_path.write_text(json.dumps(row, ensure_ascii=False) + "\n")

        content = (
            record.get("message", {}).get("content")
            if isinstance(record.get("message"), dict)
            else (record.get("attachment") or {}).get("prompt")
        )
        print(json.dumps({
            "version": version, "case": "queued-paste-944",
            "chars": len(QUEUED_INPUT), "newlines": QUEUED_INPUT.count("\n"),
            "record_type": record.get("type"),
            "record_subtype": record.get("operation") or (record.get("attachment") or {}).get("type") if isinstance(record.get("attachment"), dict) else None,
            "promptSource": record.get("promptSource"),
            "enqueue_content_len": len(str(enqueue.get("content", ""))),
            "enqueue_has_wrapper": "<pasted_content" in str(enqueue.get("content", "")),
            "record_has_wrapper": "<pasted_content" in str(content),
            "recorded_prefix": str(content)[:80],
            "recorded_suffix": str(content)[-80:],
        }, ensure_ascii=False), flush=True)
        print(f"scratch={scratch}", flush=True)
    finally:
        subprocess.run(["tmux", "-L", tmux_socket, "kill-server"], env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["fuser", "-k", f"{port}/tcp"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        try:
            fake.wait(timeout=5)
        except Exception:
            fake.kill()
        fake_out.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("version", choices=["2.1.283", "2.1.285"])
    parser.add_argument("--port", type=int, default=18982)
    args = parser.parse_args()
    run(args.version, args.port)
