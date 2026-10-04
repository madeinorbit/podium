#!/usr/bin/env python3
"""Safari's real keyboard path; event timestamp -> rAF -> post-frame timer.

Run against an isolated SYNTHETIC preview, never the operator backend.
The driver URL can be an SSH-forwarded safaridriver on podium-apple-runner.
No Selenium dependency and no fabricated input events.
"""
import argparse
import json
import math
from pathlib import Path
import time
import urllib.request


def request(base, method, path, body=None):
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=encoded, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    value = result.get("value")
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(value)
    return value


def summary(values):
    ordered = sorted(values)
    return {"count": len(ordered), "median": ordered[len(ordered)//2],
            "p95": ordered[math.ceil(len(ordered)*.95)-1], "max": ordered[-1]} if ordered else None


PROBE = r"""
const ta = document.querySelector('.chat-composer-well textarea');
if (!ta) throw Error('Chat composer is not mounted');
const probe = window.__webkitTyping = {samples: [], drift: [], start: performance.now(), active: true};
const listen = event => {
    if (event.target !== ta || !event.isTrusted) return;
    const sample = {index: probe.samples.length, data: event.data, timestamp: event.timeStamp,
        dispatch: performance.now(), length: ta.value.length};
    probe.samples.push(sample);
    performance.mark('webkit-typing:input:' + sample.index, {startTime: event.timeStamp});
    requestAnimationFrame(frame => {
        sample.frame = performance.now(); sample.frameTimestamp = frame;
        setTimeout(() => {
            sample.postPaint = performance.now(); sample.latency = sample.postPaint - sample.timestamp;
            performance.mark('webkit-typing:paint:' + sample.index);
        }, 0);
    });
};
document.addEventListener('input', listen, true);
let previous = performance.now();
const drift = () => {
    if (!probe.active) return;
    const now = performance.now();
    probe.drift.push({at: now, delay: Math.max(0, now - previous - 4)});
    previous = now; probe.timer = setTimeout(drift, 4);
};
probe.timer = setTimeout(drift, 4);
probe.stop = () => {probe.active = false; clearTimeout(probe.timer); document.removeEventListener('input', listen, true)};
ta.focus();
return {userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight],
    domNodes: document.querySelectorAll('*').length,
    transcriptNodes: document.querySelectorAll('.chat-feed *').length,
    fieldSizing: CSS.supports('field-sizing', 'content'), length: ta.value.length};
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver", default="http://127.0.0.1:19659")
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--scale", type=int, choices=[1, 4], default=1)
    parser.add_argument("--session", help="Reuse a session for throwaway CSS ablations")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--profile", action="store_true")
    parser.add_argument("--css", default="")
    args = parser.parse_args()
    session = args.session or request(args.driver, "POST", "/session", {
        "capabilities": {"alwaysMatch": {"browserName": "safari", "pageLoadStrategy": "eager",
            "timeouts": {"pageLoad": 30000, "script": 30000},
            "safari:automaticProfiling": args.profile}}})["sessionId"]
    base = args.driver + "/session/" + session
    execute = lambda script, *values: request(base, "POST", "/execute/sync", {"script": script, "args": values})
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"sha": args.sha, "scale": args.scale, "session": session,
              "profiled": args.profile, "cssAblation": args.css, "startedAt": time.time()}
    try:
        request(base, "POST", "/url", {"url": args.url})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if execute("return !!document.querySelector('.chat-composer-well textarea')"):
                break
            time.sleep(.5)
        else:
            result["pageText"] = execute("return document.body.innerText")
            raise RuntimeError("Composer did not mount")
        time.sleep(2)
        if args.css:
            execute("const s=document.createElement('style');s.textContent=arguments[0];document.head.append(s)", args.css)
            time.sleep(.3)
        result["environment"] = execute(PROBE)
        actions = []
        text = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefgh"
        for char in text:
            actions += [{"type": "keyDown", "value": char}, {"type": "keyUp", "value": char},
                        {"type": "pause", "duration": 100}]
        request(base, "POST", "/actions", {"actions": [{"type": "key", "id": "typing", "actions": actions}]})
        time.sleep(.3)
        result["raw"] = execute("const p=window.__webkitTyping;p.stop();return {samples:p.samples,drift:p.drift,elapsed:performance.now()-p.start,value:document.querySelector('.chat-composer-well textarea').value}")
        if len(result["raw"]["samples"]) != 60 or not result["raw"]["value"].endswith(text):
            raise RuntimeError("Expected exactly 60 trusted input events and intact final text")
        result["inputToPostPaintMs"] = summary([s["latency"] for s in result["raw"]["samples"]])
        result["timerDriftMs"] = summary([s["delay"] for s in result["raw"]["drift"]])
        result["inputIntervalsMs"] = summary([b["timestamp"]-a["timestamp"] for a, b in zip(result["raw"]["samples"], result["raw"]["samples"][1:])])
        print(json.dumps({k: v for k, v in result.items() if k != "raw"}), flush=True)
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        output.write_text(json.dumps(result, indent=2) + "\n")
        if not args.keep:
            request(args.driver, "DELETE", "/session/" + session)


if __name__ == "__main__":
    main()
