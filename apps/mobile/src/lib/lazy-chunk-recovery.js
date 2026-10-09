/**
 * Web Metro chunks use script tags. Expo drops rejected downloads from its
 * cache, so another load can recover without a document reload. Keep the SAME
 * import pending: rejecting it poisons lazy consumers and can unmount the app.
 * Only script transport errors enter recovery; module factory errors still
 * reject normally. Native uses Expo's original async-require module.
 *
 * This surface is outside React because the first failed chunk can prevent
 * the root from mounting. It owns no account, replica or screen data.
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000]
const pending = new Map()
let surface
let status
let retryButton
let listening = false

function retryAll() {
  for (const job of pending.values()) if (job.failed) job.retry()
}

function showRecovery() {
  const failed = [...pending.values()].filter((job) => job.failed)
  if (failed.length === 0) {
    surface?.remove()
    surface = undefined
    if (listening) window.removeEventListener('online', retryAll)
    listening = false
    return
  }
  if (!surface) {
    surface = document.createElement('section')
    surface.setAttribute('role', 'status')
    surface.setAttribute('aria-live', 'polite')
    surface.setAttribute('aria-label', 'Screen loading interrupted')
    Object.assign(surface.style, {
      position: 'fixed', inset: '0', zIndex: '2147483647', background: '#16171a',
      color: '#f2f3f5', fontFamily: 'system-ui, sans-serif', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '24px', textAlign: 'center', boxSizing: 'border-box',
    })
    const title = document.createElement('strong')
    title.textContent = 'Connection interrupted'
    title.style.fontSize = '22px'
    status = document.createElement('p')
    status.style.maxWidth = '22rem'
    retryButton = document.createElement('button')
    retryButton.type = 'button'
    retryButton.textContent = 'Retry'
    Object.assign(retryButton.style, {
      font: 'inherit', fontSize: '17px', minHeight: '44px', padding: '12px 24px',
      border: '1px solid #3a3f48', borderRadius: '12px', background: '#23262d',
      color: '#f2f3f5', cursor: 'pointer',
    })
    retryButton.addEventListener('click', retryAll)
    surface.append(title, status, retryButton)
    ;(document.body ?? document.documentElement).appendChild(surface)
  }
  const trying = failed.some((job) => job.running || job.timer !== undefined)
  status.textContent = trying ? 'Loading this screen again…' : 'Check your connection, then retry.'
  retryButton.disabled = failed.every((job) => job.running)
  if (!listening) {
    window.addEventListener('online', retryAll)
    listening = true
  }
}

/** One in-flight import per bundle, including its bounded recovery attempts. */
function loadBundleWithRecovery(bundle, load) {
  if (typeof document === 'undefined') return load(bundle)
  const existing = pending.get(bundle)
  if (existing) return existing.promise

  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  const job = { promise, failed: false, running: false, timer: undefined, retry }
  let attempt = 0
  function retry() {
    if (job.running) return
    attempt = 0
    run()
  }
  function finish(error) {
    pending.delete(bundle)
    showRecovery()
    if (error === undefined) resolve()
    else reject(error)
  }
  function run() {
    if (job.timer !== undefined) clearTimeout(job.timer)
    job.timer = undefined
    job.running = true
    attempt++
    if (job.failed) showRecovery()
    Promise.resolve().then(() => load(bundle)).then(
      () => finish(),
      (error) => {
        job.running = false
        if (error?.name !== 'AsyncRequireError' || error.type !== 'error') {
          finish(error)
          return
        }
        job.failed = true
        const delay = RETRY_DELAYS_MS[attempt - 1]
        if (delay !== undefined) job.timer = setTimeout(run, delay)
        // After the budget, park visibly until Retry or a real online event.
        // Do not reject the promise awaited by React or pool attachment.
        showRecovery()
      },
    )
  }
  pending.set(bundle, job)
  run()
  return promise
}

module.exports = { loadBundleWithRecovery }
