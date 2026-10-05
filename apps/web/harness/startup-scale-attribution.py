"""Clip startup samples to navigation → first row Paint and map production sources."""
import argparse
import bisect
from collections import defaultdict
import gzip
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
            self.cache[name] = None
            if path.exists():
                mapping = json.loads(path.read_text())
                alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
                lines, source, original_line, original_column = [], 0, 0, 0
                for raw_line in mapping['mappings'].split(';'):
                    segments, generated = [], 0
                    for raw in raw_line.split(','):
                        if not raw:
                            continue
                        values, value, shift = [], 0, 0
                        for character in raw:
                            digit = alphabet.index(character)
                            value += (digit & 31) << shift
                            if digit & 32:
                                shift += 5
                            else:
                                values.append(-(value >> 1) if value & 1 else value >> 1)
                                value = shift = 0
                        generated += values[0]
                        if len(values) >= 4:
                            source += values[1]
                            original_line += values[2]
                            original_column += values[3]
                            location = mapping['sources'][source]
                            dependency = location.rfind('/node_modules/')
                            if dependency >= 0:
                                location = location[dependency + 1:]
                            else:
                                for prefix in ['apps/', 'packages/']:
                                    if prefix in location:
                                        location = location[location.index(prefix):]
                                        break
                            segments.append((generated, location, original_line + 1))
                    lines.append(segments)
                self.cache[name] = lines
        lines = self.cache[name]
        if lines is None or line >= len(lines):
            return None
        segments = lines[line]
        index = bisect.bisect_right([segment[0] for segment in segments], column) - 1
        return segments[index][1:] if index >= 0 else None


def analyze(directory, build):
    run = json.loads((directory / 'run.json').read_text())
    maps, summaries = Maps(build), []
    for action in run['actions']:
        if not action['profiled']:
            continue
        trace = json.loads(gzip.decompress((directory / action['trace']).read_bytes()))
        navigation = next(event for event in trace if event['name'] == 'comparison:navigation-start')
        dom = next(event for event in trace if event['name'] == 'comparison:startup-dom')
        paint = min((event for event in trace if event['name'] == 'Paint' and event['ph'] == 'X'
                     and event['pid'] == navigation['pid'] and event['ts'] >= dom['ts']), key=lambda e: e['ts'])
        start, end = navigation['ts'], paint['ts'] + paint.get('dur', 0)
        profile = json.loads((directory / action['cpu']).read_text())
        nodes = {node['id']: node for node in profile['nodes']}
        parents = {child: node['id'] for node in profile['nodes'] for child in node.get('children', [])}
        locations = {node_id: maps.locate(node['callFrame']) for node_id, node in nodes.items()}
        leaves, inclusive, frames = defaultdict(float), defaultdict(float), defaultdict(float)
        clock = profile['startTime']
        for node_id, delta in zip(profile['samples'], profile['timeDeltas']):
            previous, clock = clock, clock + delta
            ms = max(0, min(clock, end) - max(previous, start)) / 1000
            if not ms:
                continue
            location = locations[node_id]
            label = location[0] if location else nodes[node_id]['callFrame']['functionName'] or 'unmapped'
            leaves[label] += ms
            frames[(label, location[1] if location else 0, nodes[node_id]['callFrame']['functionName'])] += ms
            seen, cursor = set(), node_id
            while cursor in nodes:
                mapped = locations[cursor]
                if mapped:
                    seen.add(mapped[0])
                cursor = parents.get(cursor)
            for source in seen:
                inclusive[source] += ms
        wall = (end - start) / 1000
        assert sum(leaves.values()) <= wall + 0.01, 'Sample intervals overlap'
        summaries.append({'action': action['action'], 'wallMs': wall, 'mainThreadCpuMs': action['mainThreadCpuMs'],
            'exclusiveMs': sorted(leaves.items(), key=lambda pair: -pair[1]),
            'inclusiveMs': sorted(inclusive.items(), key=lambda pair: -pair[1]),
            'frames': [{'source': key[0], 'line': key[1], 'function': key[2], 'selfMs': ms}
                       for key, ms in sorted(frames.items(), key=lambda pair: -pair[1])[:60]]})
    output = {'sha': run['sha'], 'semanticSha256': run['semanticSha256'], 'profiles': summaries,
              'scope': 'Sampled wall intervals before first row Paint. Exclusive values partition samples; inclusive values overlap.'}
    (directory / 'startup-attribution.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--build', type=Path, default=Path('apps/web/dist'))
    args = parser.parse_args()
    analyze(args.directory, args.build)
