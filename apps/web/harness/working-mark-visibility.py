#!/usr/bin/env python3
"""Observe real platform skipping and resumption in the isolated mark fixture.

Run foreground under the benchmark host's lease. This supplies interaction
evidence, never CPU/typing measurements. It moves the SAME nodes through CSS
containment and display:none, without mounting replacements or polling during
idle. Three compressed element screenshots observe motion after return.
Safari uses its real driver; Chrome uses the owned loopback adapter. Optionally
assert an already configured reduced-motion media preference without adding
the fixture's manual override. No global OS preference is changed here.
"""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import time
import urllib.parse

from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location('mark_bench', Path(__file__).with_name('working-mark-bench.py'))
bench = module_from_spec(spec)
spec.loader.exec_module(bench)

SNAPSHOT = r"""
const marks = [...document.querySelectorAll('#roster .mark')];
const mark = marks[0];
const img = mark.querySelector('img');
const source = mark.querySelector('source');
return {fixture:window.__workingMarkFixture,
  sameNode:window.__stableMark===mark, marks:marks.length,
  skipped:typeof mark.checkVisibility==='function' ? marks.filter(m=>!m.checkVisibility({contentVisibilityAuto:true})).length : null,
  reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
  focused:document.hasFocus(), documentVisibility:document.visibilityState,
  // No style query of skipped children. These are only sampled when visible.
  animationName:!document.body.classList.contains('offscreen') && !document.body.classList.contains('hidden') ? getComputedStyle(mark.querySelector('.dots')).animationName : null,
  highlightAnimation:!document.body.classList.contains('offscreen') && !document.body.classList.contains('hidden') && mark.classList.contains('signal') ? getComputedStyle(mark,'::after').animationName : null,
  stillImageSelected:img ? img.currentSrc === new URL(source.srcset,location.href).href : null};
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--session', required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--reduced', action='store_true', help='Require actual reduced-motion media match, not the manual preview toggle')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    base = args.driver.rstrip('/') + '/session/' + args.session
    bench.park_on_exit(base, args.out)
    execute = lambda script: bench.request(base, 'POST', '/execute/sync', {'script': script, 'args': []})
    outcomes = []
    for candidate in ['static', 'breathe', 'signal', 'apng', 'webp']:
        label = candidate + ('-media-reduce' if args.reduced else '')
        result = {'candidate': candidate, 'sha': args.sha, 'startedAt': time.time(), 'reducedExpected': args.reduced, 'states': [], 'frames': {}}
        try:
            params = urllib.parse.urlencode({'bench': '1', 'count': 32, 'candidate': candidate})
            bench.request(base, 'POST', '/url', {'url': args.url + '?' + params})
            execute("window.__stableMark=document.querySelector('#roster .mark');window.__stableMark.id='working-mark-probe';document.querySelector('#composer').focus();return null")
            time.sleep(1)
            element = bench.request(base, 'POST', '/element', {'using': 'css selector', 'value': '#working-mark-probe'})
            element_id = element['element-6066-11e4-a52e-4f735466cecf']

            def snapshot(name, skipped):
                state = execute(SNAPSHOT)
                result['states'].append({'stage': name, **state})
                if not state['sameNode'] or state['marks'] != 32 or state['skipped'] != skipped or state['reducedMotion'] != args.reduced or not state['focused'] or state['documentVisibility'] != 'visible':
                    raise RuntimeError(f'Platform state mismatch at {name}: {state}')
                if args.reduced and skipped == 0:
                    if state['animationName'] != 'none' or state['highlightAnimation'] not in (None, 'none') or state['stillImageSelected'] is False:
                        raise RuntimeError(f'Reduced motion is not still at {name}: {state}')

            def frames(name):
                hashes = []
                for index in range(3):
                    pixels = base64.b64decode(bench.request(base, 'GET', '/element/' + element_id + '/screenshot'))
                    path = args.out / f'{label}-{name}-{index + 1}.png'
                    path.write_bytes(pixels)
                    hashes.append(hashlib.sha256(pixels).hexdigest())
                    time.sleep(.4)
                result['frames'][name] = hashes
                should_move = candidate != 'static' and not args.reduced
                if (len(set(hashes)) > 1) != should_move:
                    raise RuntimeError(f'Expected moving={should_move}, observed frame hashes={hashes} at {name}')

            snapshot('initial-visible', 0)
            frames('initial-visible')
            for mode in ['offscreen', 'hidden']:
                execute("document.body.classList.add('" + mode + "');return null")
                time.sleep(1)
                snapshot(mode, 32)
                # No screenshot/style query of invisible content forces a draw.
                time.sleep(1)
                execute("document.body.classList.remove('" + mode + "');return null")
                time.sleep(1)
                snapshot(mode + '-return', 0)
                frames(mode + '-return')
        except Exception as error:
            result['error'] = str(error)
            raise
        finally:
            result['endedAt'] = time.time()
            with gzip.open(args.out / f'{label}.json.gz', 'wt') as file:
                json.dump(result, file, separators=(',', ':'))
            compact = {key: result[key] for key in ['candidate', 'reducedExpected', 'error'] if key in result}
            compact['completedStages'] = [state['stage'] for state in result['states']]
            outcomes.append(compact)
            with gzip.open(args.out / 'summary.json.gz', 'wt') as file:
                json.dump(outcomes, file, separators=(',', ':'))
            print(json.dumps(compact), flush=True)


if __name__ == '__main__':
    main()
