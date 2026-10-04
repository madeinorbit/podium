#!/usr/bin/env python3
"""Native Safari caret boundary against the synthetic typing fixture only."""
import argparse
import json
from pathlib import Path
import time

from importlib.machinery import SourceFileLoader

probe = SourceFileLoader("typing_probe", str(Path(__file__).with_name("webkit-typing.py"))).load_module()

FIND_CONTROLLER = r"""
const ta=document.querySelector('.chat-composer-well textarea');
const key=Object.keys(ta).find(key=>key.startsWith('__reactFiber$'));
if(!key)throw Error('No React fiber on synthetic composer');
let root=ta[key];while(root.return)root=root.return;
const stack=[root];let visited=0;
while(stack.length && visited++<100000){
    const fiber=stack.pop();if(fiber.child)stack.push(fiber.child);if(fiber.sibling)stack.push(fiber.sibling);
    for(let slot=fiber.memoizedState;slot;slot=slot.next){
        const value=Array.isArray(slot.memoizedState)?slot.memoizedState[0]:slot.memoizedState;
        if(typeof value?.setDraft==='function' && typeof value?.getSnapshot==='function' && value.options?.sessionId===arguments[0]){
            window.__syntheticDraftController=value;return true;
        }
    }
}
throw Error('No addressed synthetic draft controller');
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver", default="http://127.0.0.1:19659")
    parser.add_argument("--session", required=True)
    parser.add_argument("--control", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    base = args.driver + "/session/" + args.session
    execute = lambda script, *values: probe.request(base, "POST", "/execute/sync", {"script": script, "args": values})
    execute(FIND_CONTROLLER, args.control)
    seed = "abcdefghijklmnopqrst"
    read = lambda: execute("const t=document.querySelector('.chat-composer-well textarea');return {start:t.selectionStart,end:t.selectionEnd,direction:t.selectionDirection,value:t.value,focused:document.activeElement===t}")
    def keys(actions):
        probe.request(base, "POST", "/actions", {"actions": [{"type": "key", "id": "caret", "actions": actions}]})
    def press(value):
        return [{"type": "keyDown", "value": value}, {"type": "keyUp", "value": value}]
    results = []
    try:
        for phase in ["insert", "replace-selection", "external-sync", "external-selection"]:
            execute("window.__syntheticDraftController.setDraft(arguments[0])", seed)
            time.sleep(.7)
            point = execute("const t=document.querySelector('.chat-composer-well textarea');t.focus();const r=t.getBoundingClientRect(),s=getComputedStyle(t),c=document.createElement('canvas').getContext('2d');c.font=s.font;return {x:Math.round(r.left+parseFloat(s.paddingLeft)+c.measureText('abcde').width),y:Math.round(r.top+parseFloat(s.paddingTop)+(parseFloat(s.lineHeight)||18)/2)}")
            probe.request(base, "POST", "/actions", {"actions": [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
                {"type": "pointerMove", "origin": "viewport", "duration": 0, **point}, {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}]})
            if phase in ["replace-selection", "external-selection"]:
                keys(press("\ue014") * 3 + [{"type": "keyDown", "value": "\ue008"}] + press("\ue012") * 3 + [{"type": "keyUp", "value": "\ue008"}])
            before = read()
            if before["start"] == len(seed) or not before["focused"]:
                raise RuntimeError("Native click did not establish a middle-of-text caret")
            external = phase.startswith("external")
            if external:
                execute("window.__syntheticDraftController.setDraft(arguments[0])", seed + " appended")
            else:
                keys(press("Z"))
            time.sleep(.7)
            after = read()
            expected_start = before["start"] + (0 if external else 1)
            expected_end = before["end"] if external else expected_start
            expected_value = seed + " appended" if external else seed[:before["start"]] + "Z" + seed[before["end"]:]
            passed = after["start"] == expected_start and after["end"] == expected_end and after["value"] == expected_value and after["focused"] and (not external or before["direction"] == after["direction"])
            results.append({"phase": phase, "before": before, "after": after, "passed": passed})
            print(json.dumps({"phase": phase, "passed": passed, "selection": [after["start"], after["end"], after["direction"]]}), flush=True)
        if not all(result["passed"] for result in results):
            raise RuntimeError("Native caret acceptance failed")
    finally:
        Path(args.out).write_text(json.dumps({"sha": args.sha, "results": results}, indent=2) + "\n")
        probe.request(base, "DELETE", "/actions")
        execute("window.__syntheticDraftController.setDraft('');delete window.__syntheticDraftController")


if __name__ == "__main__":
    main()
