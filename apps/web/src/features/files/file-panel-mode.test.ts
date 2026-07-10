import { describe, expect, it } from 'vitest'
import type { UiState } from '@/app/replica'
import {
  FILE_MODE_MAP_CAP,
  HTML_MODE_MAP_KEY,
  readFilePanelMode,
  writeFilePanelMode,
} from './file-panel-mode'

/** Minimal in-memory UiState. */
function makeUi(seed: Record<string, string> = {}): { ui: UiState; data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    ui: {
      get: (k) => data.get(k) ?? null,
      set: (k, v) => {
        if (v === null) data.delete(k)
        else data.set(k, v)
      },
      subscribe: () => () => {},
    },
  }
}

describe('file-panel-mode map', () => {
  it('round-trips per-file modes through one JSON-map row', () => {
    const { ui, data } = makeUi()
    expect(readFilePanelMode(ui, HTML_MODE_MAP_KEY, 'file:a:/x.html')).toBeNull()
    writeFilePanelMode(ui, HTML_MODE_MAP_KEY, 'file:a:/x.html', 'split')
    writeFilePanelMode(ui, HTML_MODE_MAP_KEY, 'file:b:/y.html', 'source')
    expect(readFilePanelMode(ui, HTML_MODE_MAP_KEY, 'file:a:/x.html')).toBe('split')
    expect(readFilePanelMode(ui, HTML_MODE_MAP_KEY, 'file:b:/y.html')).toBe('source')
    // One row for the whole family — no per-file keys.
    expect([...data.keys()]).toEqual([HTML_MODE_MAP_KEY])
  })

  it('a corrupt or non-mode value reads as null (fallback default applies)', () => {
    const { ui } = makeUi({ [HTML_MODE_MAP_KEY]: '{not json' })
    expect(readFilePanelMode(ui, HTML_MODE_MAP_KEY, 'file:a:/x.html')).toBeNull()
    const { ui: ui2 } = makeUi({ [HTML_MODE_MAP_KEY]: '{"file:a:/x.html":"bogus"}' })
    expect(readFilePanelMode(ui2, HTML_MODE_MAP_KEY, 'file:a:/x.html')).toBeNull()
  })

  it('an unchanged write is a no-op (no storage churn)', () => {
    const { ui, data } = makeUi()
    writeFilePanelMode(ui, HTML_MODE_MAP_KEY, 'id', 'preview')
    const before = data.get(HTML_MODE_MAP_KEY)
    data.set(HTML_MODE_MAP_KEY, before ?? '') // canary: same reference check via value
    writeFilePanelMode(ui, HTML_MODE_MAP_KEY, 'id', 'preview')
    expect(data.get(HTML_MODE_MAP_KEY)).toBe(before)
  })

  it('bounds the map: least-recently-written entries drop past the cap', () => {
    const { ui } = makeUi()
    for (let i = 0; i < FILE_MODE_MAP_CAP + 5; i++) {
      writeFilePanelMode(ui, HTML_MODE_MAP_KEY, `id${i}`, 'source')
    }
    const map = JSON.parse(ui.get(HTML_MODE_MAP_KEY) ?? '{}') as Record<string, string>
    expect(Object.keys(map)).toHaveLength(FILE_MODE_MAP_CAP)
    expect(map.id0).toBeUndefined() // oldest evicted
    expect(map[`id${FILE_MODE_MAP_CAP + 4}`]).toBe('source') // newest kept
    // Re-writing an existing id refreshes its recency.
    writeFilePanelMode(ui, HTML_MODE_MAP_KEY, 'id10', 'split')
    writeFilePanelMode(ui, HTML_MODE_MAP_KEY, 'idNEW', 'preview')
    const after = JSON.parse(ui.get(HTML_MODE_MAP_KEY) ?? '{}') as Record<string, string>
    expect(after.id10).toBe('split')
  })
})
