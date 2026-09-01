(() => {
  // Match the native and React pre-activation buffers: accepted FIFO work is
  // never evicted, and the newest input is rejected once all 32 slots are full.
  const PENDING_CAPACITY = 32
  const pending = []
  let ready = false
  const dispatch = (raw) =>
    window.dispatchEvent(new CustomEvent('podium:native-open', { detail: raw }))

  window.__PODIUM_DELIVER_NATIVE_OPEN__ = (raw) => {
    if (typeof raw !== 'string') return
    if (ready) dispatch(raw)
    else if (pending.length < PENDING_CAPACITY) pending.push(raw)
  }

  window.__PODIUM_NATIVE_OPEN_READY__ = (next = true) => {
    if (next === false) {
      ready = false
      return
    }
    if (ready) return
    ready = true
    for (const raw of pending.splice(0)) dispatch(raw)
  }
})()
