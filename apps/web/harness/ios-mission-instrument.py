"""Instrument an owned throwaway checkout; never include this patch in product.

Build both clients after running from the checkout root, then restore the
controller from .artifacts/controller-product.ts. Counters retain only numbers.
"""
from pathlib import Path

path = Path('packages/client-core/src/transcript/controller.ts')
source = path.read_text()
assert '__fixtureTranscriptCounts' not in source, 'Restore the product controller first'
backup = Path('.artifacts/controller-product.ts')
backup.parent.mkdir(parents=True, exist_ok=True)
backup.write_text(source)
counts_type = ('Record<string, { items: number; maximum: number; '
               'maximumInput: number; updates: number }>')
bound = '    const limit = this.initialLimit * 2\n'
assert source.count(bound) == 1
source = source.replace(bound, bound + '''    const fixture = globalThis as typeof globalThis & { __fixtureTranscriptCounts?: COUNTS; __fixtureRetainAll?: boolean }
    const counts = fixture.__fixtureTranscriptCounts ??= {}
    const previous = counts[this.options.sessionId]
    counts[this.options.sessionId] = { items: this.state.items.length, maximum: previous?.maximum ?? 0, maximumInput: Math.max(items.length, previous?.maximumInput ?? 0), updates: previous?.updates ?? 0 }
    if (fixture.__fixtureRetainAll) return { items }
'''.replace('COUNTS', counts_type))
publish = '    this.state = { ...this.state, ...patch }\n'
assert source.count(publish) == 1
source = source.replace(publish, publish + '''    const fixture = globalThis as typeof globalThis & { __fixtureTranscriptCounts?: COUNTS }
    const counts = fixture.__fixtureTranscriptCounts ??= {}
    const previous = counts[this.options.sessionId]
    counts[this.options.sessionId] = { items: this.state.items.length, maximum: Math.max(this.state.items.length, previous?.maximum ?? 0), maximumInput: previous?.maximumInput ?? 0, updates: (previous?.updates ?? 0) + 1 }
'''.replace('COUNTS', counts_type))
path.write_text(source)
