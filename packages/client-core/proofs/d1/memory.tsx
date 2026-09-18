/** Fresh-process memory evidence. Run under test-heavy, never concurrently. */
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const output = fileURLToPath(new URL('./results/', import.meta.url))
if (!process.argv.includes('--child')) {
  const results = []
  for (const candidate of ['mobx', 'tanstack']) for (const readers of [200, 1000]) for (const addressing of ['same', 'distinct']) {
    const child = Bun.spawn(['bun', '--conditions=@podium/source', import.meta.path, '--child', candidate, String(readers), addressing],
      { cwd: root, stdout: 'pipe', stderr: 'inherit', env: process.env })
    const text = await new Response(child.stdout).text()
    if (await child.exited) throw new Error(`Memory child failed: ${candidate}/${readers}/${addressing}: ${text}`)
    results.push(JSON.parse(text.trim().split('\n').at(-1)!))
  }
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'memory.json'), JSON.stringify({ method: 'One fresh Bun process per case; happy-dom + React DOM 19.2.7; three synchronous GC samples; fixture and library imports excluded from baseline delta. Not device memory.', results }, null, 2) + '\n')
} else {
  const [candidate, readerArg, addressing] = process.argv.slice(process.argv.indexOf('--child') + 1)
  const readers = Number(readerArg)
  const require = createRequire(join(root, 'package.json'))
  const { Window } = await import(require.resolve('happy-dom'))
  const window = new Window()
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const React = await import(require.resolve('react'))
  const { createRoot } = await import(require.resolve('react-dom/client'))
  const { fixture } = await import('./model')
  const mobx = await import('./mobx')
  const tanstack = await import('./tanstack')
  const data = fixture()
  const heap = async () => {
    const samples = []
    for (let n = 0; n < 3; n++) { await new Promise(resolve => setTimeout(resolve, 10)); Bun.gc(true); samples.push(process.memoryUsage().heapUsed) }
    return { samples, median: [...samples].sort((a, b) => a - b)[1]! }
  }
  const before = await heap()
  const proof = candidate === 'mobx' ? mobx.createMobxProof(data) : tanstack.createTanstackProof(data)
  const Row = candidate === 'mobx' ? mobx.MobxRow : tanstack.TanstackRow
  const Summary = candidate === 'mobx' ? mobx.MobxSummary : tanstack.TanstackSummary
  const Group = candidate === 'mobx' ? mobx.MobxGroup : tanstack.TanstackGroup
  let commits = 0
  const elements = [
    ...Array.from({ length: readers }, (_, n) => React.createElement(Row as React.ElementType, { key: n, proof,
      id: `s${addressing === 'same' ? 0 : n}`, reader: n, read() {}, commit() { commits++ } })),
    React.createElement(Summary as React.ElementType, { key: 'a', proof, read() {} }),
    React.createElement(Summary as React.ElementType, { key: 'b', proof, read() {} }),
    React.createElement(Group as React.ElementType, { key: 'g', proof, read() {} }),
  ]
  const container = window.document.createElement('div')
  const renderer = createRoot(container)
  await React.act(async () => { renderer.render(React.createElement(React.Fragment, null, elements)); await Promise.resolve() })
  if (commits < readers) throw new Error(`Only ${commits}/${readers} mounted`)
  const mounted = await heap()
  await React.act(async () => renderer.unmount())
  await proof.dispose()
  const disposed = await heap()
  console.log(JSON.stringify({ candidate, readers, addressing, commits, before, mounted, disposed,
    mountedDeltaBytes: mounted.median - before.median, afterDisposeDeltaBytes: disposed.median - before.median }))
  await window.happyDOM.close()
}
