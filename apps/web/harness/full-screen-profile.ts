/** Opt-in observers for the ordinary production speed fixture. No profiling renderer. */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CDPSession, Page } from '@playwright/test'

type TraceEvent = { name: string; ph: string; ts: number; pid: number; tid: number; dur?: number }
export async function traceStart(cdp: CDPSession) {
  const events: TraceEvent[] = []
  const receive = ({ value }: { value: unknown[] }) => events.push(...(value as TraceEvent[]))
  cdp.on('Tracing.dataCollected', receive)
  await cdp.send('Tracing.start', { categories: PROFILE_CATEGORIES, transferMode: 'ReportEvents' })
  return async () => {
    const complete = new Promise<void>(done => cdp.once('Tracing.tracingComplete', () => done()))
    await cdp.send('Tracing.end')
    await complete
    cdp.off('Tracing.dataCollected', receive)
    return events
  }
}

export const PROFILE_CATEGORIES =
  'toplevel,devtools.timeline,blink.user_timing'

type Fiber = {
  tag: number
  flags: number
  type: unknown
  child: Fiber | null
  sibling: Fiber | null
}
type Commit = {
  at: number
  end: number
  components: Record<number, number>
  visited: number
  reused: number
}
declare global {
  interface Window {
    __speedReact: { renderer: Record<string, unknown> | null; commits: Commit[] }
    __speedFunctions: Function[]
    __speedPaneMode(): 'legacy' | 'pool'
  }
}

/** React 19.2's DevTools hook; PerformedWork is bit 1 for composite fibers.
 * Counts committed renders, excluding DOM nodes, providers and bailed-out fibers.
 * Abandoned/restarted render attempts are visible only in the CPU recording. */
export async function installCommitObserver(page: Page) {
  await page.addInitScript(() => {
    const functions: Function[] = []
    const ids = new WeakMap<Function, number>()
    let previousFibers = new WeakSet<Fiber>()
    const state = { renderer: null as Record<string, unknown> | null, commits: [] as Commit[] }
    window.__speedReact = state
    window.__speedFunctions = functions
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        inject(renderer: Record<string, unknown>) {
          state.renderer = {
            version: renderer.version,
            bundleType: renderer.bundleType,
            rendererPackageName: renderer.rendererPackageName,
          }
          return 1
        },
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          const observing = window.__speedCapture?.input != null
          const at = performance.now()
          if (observing) performance.mark(`speed:commit:${state.commits.length}`)
          const components: Record<number, number> = {}
          const nextFibers = new WeakSet<Fiber>()
          let visited = 0
          let reused = 0
          const stack = [root.current]
          while (stack.length) {
            const fiber = stack.pop()!
            visited++
            nextFibers.add(fiber)
            if (fiber.sibling) stack.push(fiber.sibling)
            if (fiber.child) stack.push(fiber.child)
            // A bailed-out subtree can retain PerformedWork from its earlier
            // commit. React reuses those exact objects; they did not render now.
            if (previousFibers.has(fiber)) { reused++; continue }
            if (!observing) continue
            if (!(fiber.flags & 1) || ![0, 1, 11, 14, 15].includes(fiber.tag)) continue
            let type = fiber.type as Function | { render?: Function; type?: Function } | null
            if (type && typeof type !== 'function') type = type.render ?? type.type ?? null
            if (typeof type !== 'function') continue
            let id = ids.get(type)
            if (id === undefined) {
              id = functions.length
              functions.push(type)
              ids.set(type, id)
            }
            components[id] = (components[id] ?? 0) + 1
          }
          previousFibers = nextFibers
          if (observing) state.commits.push({ at, end: performance.now(), components, visited, reused })
        },
        onCommitFiberUnmount() {},
      },
    })
  })
}

export async function startCpu(cdp: CDPSession) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
  await cdp.send('Profiler.start')
  return async () => (await cdp.send('Profiler.stop')).profile
}

/** FunctionLocation gives the original composite's generated coordinates even
 * when esbuild has shortened its name. Source-map these alongside CPU frames. */
export async function saveComponentLocations(page: Page, cdp: CDPSession, path: string) {
  const scripts = new Map<string, { url: string; sourceMapURL?: string }>()
  const parsed = (script: { scriptId: string; url: string; sourceMapURL?: string }) => {
    scripts.set(script.scriptId, script)
  }
  cdp.on('Debugger.scriptParsed', parsed)
  await cdp.send('Debugger.enable')
  try {
    const count = await page.evaluate(() => window.__speedFunctions.length)
    const components = []
    for (let id = 0; id < count; id++) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `window.__speedFunctions[${id}]`,
        objectGroup: 'speed-components',
      })
      if (!result.objectId) throw new Error(`Missing component function ${id}`)
      const properties = await cdp.send('Runtime.getProperties', { objectId: result.objectId })
      const location = properties.internalProperties?.find(
        (entry) => entry.name === '[[FunctionLocation]]',
      )?.value?.value as { scriptId: string; lineNumber: number; columnNumber: number } | undefined
      if (!location) throw new Error(`Missing component FunctionLocation ${id}`)
      const name = properties.result.find((entry) => entry.name === 'displayName')?.value?.value ??
        properties.result.find((entry) => entry.name === 'name')?.value?.value
      // Minification can erase an observer wrapper's name. Its closure keeps
      // the original render function; capture only function coordinates (no
      // scope values), after all timed samples, for unambiguous source mapping.
      const wrappedFunctions = []
      const scopesId = properties.internalProperties?.find(entry => entry.name === '[[Scopes]]')?.value?.objectId
      if (scopesId) {
        const scopes = await cdp.send('Runtime.getProperties', { objectId: scopesId })
        const closures = scopes.result.filter(entry => entry.value?.description?.startsWith('Closure')).slice(0, 2)
        const seen = new Set<string>()
        for (const closure of closures) {
          if (!closure.value?.objectId) continue
          const variables = await cdp.send('Runtime.getProperties', { objectId: closure.value.objectId })
          for (const variable of variables.result) {
            if (variable.value?.type !== 'function' || !variable.value.objectId) continue
            const fields = await cdp.send('Runtime.getProperties', { objectId: variable.value.objectId })
            const original = fields.internalProperties?.find(entry => entry.name === '[[FunctionLocation]]')?.value?.value as typeof location
            if (!original || (original.scriptId === location.scriptId && original.lineNumber === location.lineNumber && original.columnNumber === location.columnNumber)) continue
            const key = `${original.scriptId}:${original.lineNumber}:${original.columnNumber}`
            if (seen.has(key)) continue
            seen.add(key)
            wrappedFunctions.push({ name: fields.result.find(entry => entry.name === 'name')?.value?.value ?? '', scopeVariable: variable.name,
              ...original, url: scripts.get(original.scriptId)?.url ?? '' })
          }
        }
      }
      components.push({ id, name, ...location, ...scripts.get(location.scriptId), wrappedFunctions })
    }
    await writeFile(path, JSON.stringify(components, null, 2) + '\n')
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'speed-components' })
    await cdp.send('Debugger.disable')
    cdp.off('Debugger.scriptParsed', parsed)
  }
}

export async function saveRecording(
  directory: string,
  file: string,
  profile: Awaited<ReturnType<Awaited<ReturnType<typeof startCpu>>>>,
  events: unknown[],
  record: Record<string, unknown>,
) {
  // Preserve complete raw recordings. Analysis clips samples/events to the
  // trusted input/feed mark and the first Paint after the expected DOM change.
  await writeFile(resolve(directory, file + '.cpuprofile'), JSON.stringify(profile))
  await writeFile(resolve(directory, file + '.trace.json'), JSON.stringify({ traceEvents: events }))
  await writeFile(resolve(directory, file + '.json'), JSON.stringify(record, null, 2) + '\n')
}
