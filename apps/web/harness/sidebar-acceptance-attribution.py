#!/usr/bin/env python3
"""Exclusive sampled screen ownership, separate from headline timing.

Source-map reader and source categories follow POD-5077's archived collector.
Sample intervals are clipped to the actual selected-state Chromium Paint.
Timeline layout and async IDB latencies are separate, never added to CPU.
"""
import argparse
import bisect
import collections
import json
from pathlib import Path


class Maps:
    def __init__(self, root):
        self.root, self.cache = root, {}

    def locate(self, frame):
        name = frame['url'].rsplit('/', 1)[-1]
        line, column = frame['lineNumber'], frame['columnNumber']
        if not name.endswith('.js') or line < 0:
            return None
        if name not in self.cache:
            path = self.root / 'assets' / (name + '.map')
            if not path.exists():
                self.cache[name] = None
            else:
                source_map = json.loads(path.read_text())
                alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
                lines, source, original_line, original_column = [], 0, 0, 0
                for raw_line in source_map['mappings'].split(';'):
                    segments, generated = [], 0
                    for raw in raw_line.split(','):
                        if not raw: continue
                        values, value, shift = [], 0, 0
                        for character in raw:
                            digit = alphabet.index(character)
                            value += (digit & 31) << shift
                            if digit & 32: shift += 5
                            else:
                                values.append(-(value >> 1) if value & 1 else value >> 1)
                                value = shift = 0
                        generated += values[0]
                        if len(values) >= 4:
                            source += values[1]; original_line += values[2]; original_column += values[3]
                            location = source_map['sources'][source]
                            for prefix in ['apps/', 'packages/', 'node_modules/']:
                                if prefix in location:
                                    location = location[location.index(prefix):]; break
                            segments.append((generated, location, original_line + 1, original_column + 1))
                    lines.append(segments)
                self.cache[name] = lines
        lines = self.cache[name]
        if lines is None or line >= len(lines): return None
        segments = lines[line]
        index = bisect.bisect_right([segment[0] for segment in segments], column) - 1
        return segments[index][1:] if index >= 0 else None


def category(path):
    if any(text in path for text in ['IssueChipLiveness', 'issue-chip-refs']): return 'issue chips'
    if '/adapters/indexeddb/' in path: return 'IndexedDB JS'
    if '/client-core/src/engine/' in path: return 'shared engine/navigation'
    if '/app/FlightDeck' in path or '/app/Workspace' in path: return 'Workspace/FlightDeck'
    if '/features/terminal/' in path or '/features/chat/' in path or '/terminal-client' in path: return 'session panes'
    if '/features/issues/' in path or '/app/RightDock' in path: return 'issue page/dock'
    if '/features/worklist/' in path or '/client-graph/' in path: return 'sidebar/pool'
    if '/client-core/src/viewmodels/' in path: return 'legacy viewmodels'
    if '/client-core/' in path: return 'shared legacy runtime'
    if '/sync/src/' in path: return 'sync/outbox JS'
    if 'node_modules/' in path: return 'React/framework/libraries'
    return 'other app/fixture'


def analyze(root):
    maps = Maps(root / 'build')
    directory = root / 'attribution'
    records = [json.loads(line) for line in (directory / 'records.jsonl').read_text().splitlines()]
    summaries = []
    for record in records:
        trace = json.loads((directory / record['traceFile']).read_text())['traceEvents']
        markers = record['paint']['markers']
        start, end = markers['input'], markers['paintEnd']
        assert sum(event['name'] == 'acceptance:input' for event in trace) == 1
        assert end > start
        profile = json.loads((directory / record['traceFile'].replace('.trace.json', '.cpuprofile')).read_text())
        nodes = {node['id']: node for node in profile['nodes']}
        parents = {child: node['id'] for node in profile['nodes'] for child in node.get('children', [])}
        classes, leaves = {}, {}
        specific = {'shared engine/navigation', 'Workspace/FlightDeck', 'issue page/dock', 'session panes', 'issue chips', 'sidebar/pool', 'IndexedDB JS'}
        for node_id, node in nodes.items():
            frame = node['callFrame']
            chain, cursor = [], node_id
            while cursor in nodes:
                location = maps.locate(nodes[cursor]['callFrame'])
                if location: chain.append(location[0])
                if cursor not in parents: break
                cursor = parents[cursor]
            leaves[node_id] = (frame['functionName'], maps.locate(frame))
            classes[node_id] = 'native rectangle/layout' if frame['functionName'] == 'getBoundingClientRect' else next(
                (category(path) for path in chain if category(path) in specific),
                category(chain[0]) if chain else frame['functionName'] if frame['functionName'] in ['(idle)', '(garbage collector)', '(program)'] else 'native/unmapped')
        clock, points = profile['startTime'], []
        for node_id, delta in zip(profile['samples'], profile['timeDeltas']):
            clock += delta; points.append((clock, node_id))
        totals, functions, previous = collections.defaultdict(float), collections.defaultdict(float), profile['startTime']
        for clock, node_id in sorted(points):
            span = max(0, min(clock, end) - max(previous, start)); previous = clock
            if span:
                totals[classes[node_id]] += span / 1000
                name, location = leaves[node_id]
                functions[(name, tuple(location) if location else ())] += span / 1000
        wall = (end - start) / 1000
        assert sum(totals.values()) <= wall + 0.01, 'Exclusive sample intervals exceed observed wall span'
        summaries.append({'scale': record['scale'], 'mode': record['mode'], 'target': record['target'],
            'inputToPaintMs': wall, 'sampledExclusiveMs': dict(totals),
            'timelineMs': record['paint']['layout'], 'indexedDb': record['result']['capture']['events'],
            'topFrames': [{'function': name, 'source': location, 'ms': duration} for (name, location), duration in sorted(functions.items(), key=lambda entry: -entry[1])[:15]]})
    (root / 'attribution-summary.json').write_text(json.dumps({'samplingUs': 1000,
        'scope': 'Separate profiling run. Buckets sum within each wall window; timeline and IDB request latency are not additive.',
        'records': summaries}, indent=2))
    print(f'{len(summaries)} separate source-mapped switch attributions saved')


parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, default=Path('.artifacts/sidebar-acceptance'))
analyze(parser.parse_args().root)
