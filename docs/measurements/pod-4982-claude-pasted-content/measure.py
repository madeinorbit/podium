#!/usr/bin/env python3
"""Real Claude TUI, scratch HOME, localhost fake model; no inherited credentials."""
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


def run(version, port, paste_tags, boundaries):
    binary = Path(f"/home/mgw/.local/share/claude/versions/{version}")
    scratch = Path(tempfile.mkdtemp(prefix=f"pod4982-{version}-"))
    work = scratch / "work"
    cfg = scratch / "home/.claude"
    work.mkdir()
    cfg.mkdir(parents=True)
    (cfg / "settings.json").write_text(json.dumps({"permissions": {"allow": []}}))
    (cfg / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True,
        "theme": "dark",
        "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []},
        "cachedGrowthBookFeatures": {"tengu_virtual_pancake": paste_tags},
        "projects": {str(work): {
            "hasTrustDialogAccepted": True,
            "hasCompletedProjectOnboarding": True,
            "allowedTools": [],
        }},
    }))
    # Deliberate whitelist: neither the operator's credentials nor Podium's
    # live session, hooks, or configuration can enter this child environment.
    env = {
        "PATH": os.environ["PATH"], "HOME": str(scratch / "home"),
        "SHELL": "/bin/bash", "TERM": "xterm-256color", "LANG": "C.UTF-8",
        "CLAUDE_CONFIG_DIR": str(cfg), "ANTHROPIC_API_KEY": KEY,
        "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "CLAUDE_CODE_MAX_RETRIES": "0", "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF": "1",
    }
    # Refuse an occupied port; cleanup below can only kill this run's fake.
    with socket.socket() as check:
        check.bind(("127.0.0.1", port))
    bun = subprocess.check_output(["mise", "which", "bun"], text=True).strip()
    fake_env = {**env, "FAKE_PORT": str(port), "FAKE_LOG": str(scratch / "requests.jsonl")}
    fake_out = (scratch / "fake.log").open("w")
    fake = subprocess.Popen([bun, str(FAKE)], env=fake_env, stdout=fake_out, stderr=fake_out)
    tmux_socket = f"pod4982-{version}-{os.getpid()}"

    def tmux(*args, capture=False):
        return subprocess.run(["tmux", "-L", tmux_socket, *args], env=env,
                              check=True, capture_output=capture, text=True)

    def screen():
        return tmux("capture-pane", "-p", "-t", "cli", capture=True).stdout

    def user_records():
        out = []
        for path in (cfg / "projects").rglob("*.jsonl"):
            if "subagents" in path.parts:
                continue
            for line in path.read_text().splitlines():
                rec = json.loads(line)
                if rec.get("type") == "user" and rec.get("promptSource") == "typed":
                    out.append(rec)
        return out

    def wait_until(predicate, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.1)
        raise RuntimeError(f"Timed out; scratch={scratch}\n{screen()}")

    results = []
    try:
        time.sleep(0.4)
        tmux("new-session", "-d", "-s", "cli", "-x", "180", "-y", "45",
             "-c", str(work), f"exec {shlex.quote(str(binary))} --model claude-sonnet-4-6")
        wait_until(lambda: "bypass permissions" in screen() or "❯" in screen())
        (scratch / "screen-start.txt").write_text(screen())

        def type_text(text, mode):
            if mode == "paste":
                paste_file = scratch / "input.txt"
                paste_file.write_text(text)
                tmux("load-buffer", "-b", "input", str(paste_file))
                tmux("paste-buffer", "-p", "-b", "input", "-t", "cli")
            elif mode == "burst":
                # One unbracketed terminal write, as opposed to paced keys.
                tmux("send-keys", "-t", "cli", "-l", text)
            else:
                for c in text:
                    if c == "\n":
                        tmux("send-keys", "-t", "cli", "-l", "\\")
                        tmux("send-keys", "-t", "cli", "Enter")
                    else:
                        tmux("send-keys", "-t", "cli", "-l", c)
                    time.sleep(0.012)

        def send(name, text, mode, segments=None):
            before = len(user_records())
            for segment_mode, segment_text in segments or [(mode, text)]:
                type_text(segment_text, segment_mode)
                time.sleep(0.1)
            time.sleep(0.2)
            tmux("send-keys", "-t", "cli", "Enter")
            record = wait_until(lambda: user_records()[before:] or None)[0]
            wait_until(lambda: "esc to interrupt" not in screen().lower())
            time.sleep(0.3)
            row = {"case": name, "mode": mode, "paste_tags": paste_tags,
                   "input": text, "record": record}
            results.append(row)
            suffix = ("on" if paste_tags else "off") + ("-boundaries" if boundaries else "")
            (HERE / f"claude-{version}-gate-{suffix}.jsonl").write_text(
                "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in results))
            recorded = record["message"]["content"]
            print(json.dumps({"version": version, "case": name, "mode": mode,
                              "chars": len(text), "newlines": text.count("\n"),
                              "wrapped": "<pasted_content" in str(recorded),
                              "recorded": recorded if len(str(recorded)) < 600 else str(recorded)[:90]},
                             ensure_ascii=False), flush=True)

        for mode in ["paste", "burst"]:
            sizes = [799, 800, 801] if boundaries else [16, 19, 20, 21, 323, 999, 1000, 1001, 2000]
            for n in sizes:
                prefix = f"{mode}-{n} "
                send(f"{mode}-chars-{n}", prefix + "x" * (n - len(prefix)), mode)
            for lines in [2, 3, 4, 5, 6, 10]:
                send(f"{mode}-lines-{lines}", "\n".join(f"line-{i}" for i in range(lines)), mode)
        if not boundaries:
            send("paced-short", "paced short input", "paced")
            send("paced-two-lines", "paced line one\npaced line two", "paced")
            send("paced-six-lines", "\n".join(f"paced-{i}" for i in range(6)), "paced")
            send("paced-long", "paced-long " + "x" * 990, "paced")
        repeat = "\n".join(f"repeat-{i}" for i in range(6))
        send("repeat-1", repeat, "paste")
        send("repeat-2", repeat, "paste")
        send("literal-tags", '<pasted_content id="abcd">\nliteral\n</pasted_content id="abcd">', "paste")
        send("wrapped-literal-tags", '<pasted_content id="abcd">\nliteral\nmore\n</pasted_content id="abcd">', "paste")
        send("multiline-323", "first line\nsecond line\nthird line\n" + "x" * 289, "paste")
        frame = ("[podium message msg_4982a · from agent:measured · to your session]\n"
                 "Measure the real wrapped frame.\n"
                 "Keep the mail body intact.\n"
                 "This is a fake-model measurement.\n"
                 "[end podium message msg_4982a]")
        send("framed-mail", frame, "paste")
        pieces = [("paced", "Please read: "), ("paste", "pasted first line\npasted second line\npasted third line\npasted fourth line"),
                  ("paced", " then reply.")]
        send("mixed-inline", "".join(text for _, text in pieces), "mixed", pieces)
        pieces = [("paste", "first paste\nfirst block\nthird line\nfourth line"), ("paced", " between "),
                  ("paste", "second paste\nsecond block\nthird line\nfourth line")]
        send("mixed-two-pastes", "".join(text for _, text in pieces), "mixed", pieces)
        send("outer-whitespace", "  first\nsecond\nthird\nfourth  \n", "paste")
        send("double-trailing-newline", "first\nsecond\nthird\nfourth\n\n", "paste")
        (scratch / "screen-final.txt").write_text(screen())
        print(f"scratch={scratch}", flush=True)
    finally:
        subprocess.run(["tmux", "-L", tmux_socket, "kill-server"], env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["fuser", "-k", f"{port}/tcp"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        fake.wait(timeout=5)
        fake_out.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("version", choices=["2.1.283", "2.1.285"])
    parser.add_argument("--port", type=int, default=18982)
    parser.add_argument("--paste-tags", action="store_true")
    parser.add_argument("--boundaries", action="store_true")
    args = parser.parse_args()
    run(args.version, args.port, args.paste_tags, args.boundaries)
