/** Count strong collections without retaining their members in the profiler. */
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'

const { endpoint } = JSON.parse(readFileSync(process.argv[2] + '/browser-endpoint.json', 'utf8'))
const browser = await chromium.connect(endpoint)
const cdp = await browser.newBrowserCDPSession()
const { targetInfos } = await cdp.send('Target.getTargets')
const { sessionId } = await cdp.send('Target.attachToTarget', {
  targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: false,
})
const expression = process.argv[3] === 'native'
  ? `(() => { const button = document.querySelector('[data-testid=mode-native]'); button?.click(); return {clicked: !!button}; })()`
  : process.argv[3] === 'pilot'
  ? `(() => {
      const pool = globalThis.__memoryPool?.deref();
      const id = [...(pool?.tables.issue ?? [])].find(([,row]) => row.seq === 4286)?.[0];
      const element = document.querySelector('[data-issue-row]');
      const key = element && Object.keys(element).find(k => k.startsWith('__reactFiber$'));
      for (let f = element?.[key]; f; f = f.return) {
        if (id && typeof f.memoizedProps?.onSelectIssue === 'function') {
          f.memoizedProps.onSelectIssue({id}); return {selected: true};
        }
      }
      return {selected: false, found: !!id};
    })()`
  : `(() => {
  const pool = globalThis.__memoryPool?.deref()
  if (!pool) return {found: false}
  const counts = {}, seen = new Set()
  function walk(value, path, depth) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 3) return
    seen.add(value)
    if (typeof value.size === 'number') { counts[path] = value.size; return }
    if (Array.isArray(value)) { counts[path] = value.length; return }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.value && typeof descriptor.value === 'object') walk(descriptor.value, path + '.' + key, depth + 1)
    }
  }
  walk(pool, 'pool', 0)
  for (const [key, owner] of pool.sources.views) walk(owner, 'view.' + key, 0)
  return {
    found: true, counts, viewNames: [...pool.sources.views.keys()],
    dom: {
      nativeButtons: document.querySelectorAll('[data-testid=mode-native]').length,
      terminals: document.querySelectorAll('.xterm').length,
      canvas: document.querySelectorAll('canvas').length,
      panes: document.querySelectorAll('[data-testid=agent-panel-header]').length,
      tabs: document.querySelectorAll('[data-tab-drag-id]').length,
      marks: performance.getEntriesByType('mark').length,
      measures: performance.getEntriesByType('measure').length,
      smil: document.querySelectorAll('animate,animateTransform,animateMotion').length,
    },
  }
})()`
const response = new Promise(resolve => cdp.on('Target.receivedMessageFromTarget', event => {
  const message = JSON.parse(event.message)
  if (event.sessionId === sessionId && message.id === 1) resolve(message)
}))
await cdp.send('Target.sendMessageToTarget', {
  sessionId, message: JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression, returnByValue: true}}),
})
console.log(JSON.stringify({at: new Date().toISOString(), response: await response}))
await cdp.send('Target.detachFromTarget', {sessionId})
await browser.close()
