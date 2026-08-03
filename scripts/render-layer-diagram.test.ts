/**
 * The layer diagram is a PROJECTION of the manifest, not a second opinion about
 * it (POD-335). Two obligations, and they fail for different reasons:
 *
 *  1. The committed ARCHITECTURE.md matches what the renderer produces. `--check`
 *     enforces this in CI; this asserts it in the unit lane so a stale diagram
 *     shows up in the same run as the manifest change that staled it.
 *  2. The renderer READS the manifest rather than restating it — shown by
 *     rendering a fixture manifest and observing the output change. Without (2),
 *     (1) is satisfiable by a renderer that emits a hardcoded string.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MANIFEST, type WorkspaceTags } from './architecture-manifest'
import { renderLayerDiagram, spliceDiagram } from './render-layer-diagram'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('ARCHITECTURE.md layer diagram', () => {
  it('is up to date with the manifest the lint reads', () => {
    const doc = readFileSync(join(REPO_ROOT, 'ARCHITECTURE.md'), 'utf8')
    expect(spliceDiagram(doc, renderLayerDiagram())).toBe(doc)
  })

  it('names every tagged workspace — the diagram cannot omit one', () => {
    const rendered = renderLayerDiagram()
    for (const workspace of Object.keys(MANIFEST)) {
      const name =
        workspace === 'scripts' ? 'scripts/' : `@podium/${workspace.split('/')[1] ?? workspace}`
      expect(rendered, workspace).toContain(name)
    }
  })

  it('READS the manifest — a fixture workspace appears, with its closed dep set', () => {
    // The counterfactual that separates "generated" from "a string that happens
    // to be right today".
    const fixture: Record<string, WorkspaceTags> = {
      'packages/fixture-leaf': { layer: 0, platform: 'browser-safe', features: ['fx'], deps: [] },
      'packages/fixture-port': {
        layer: 2,
        platform: 'node-only',
        features: ['fx-port'],
        deps: ['packages/fixture-leaf'],
        consumers: ['apps/daemon'],
      },
    }
    const rendered = renderLayerDiagram(fixture, new Set(['packages/fixture-port -> x']), new Set())
    expect(rendered).toContain('@podium/fixture-leaf')
    expect(rendered).toContain('nothing — this is the leaf')
    expect(rendered).toContain('host capability')
    // ...and it does NOT smuggle in the real manifest's rows.
    expect(rendered).not.toContain('@podium/model')
  })

  it('refuses to splice when the markers are missing, rather than appending a second diagram', () => {
    expect(() => spliceDiagram('# doc\n\nno markers here\n', 'x')).toThrow(/markers/)
  })
})
