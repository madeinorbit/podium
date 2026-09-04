(() => {
  // Match the native and React pre-activation buffers: accepted FIFO work is
  // never evicted, and the newest input is rejected once all 32 slots are full.
  const PENDING_CAPACITY = 32
  const pending = []
  let ready = false
  let inFlight = false
  const dispatch = (raw) =>
    window.dispatchEvent(new CustomEvent('podium:native-open', { detail: raw }))
  const dispatchNext = () => {
    if (!ready || inFlight || pending.length === 0) return
    inFlight = true
    dispatch(pending[0])
  }
  const enqueue = (raw) => {
    if (typeof raw !== 'string' || pending.length >= PENDING_CAPACITY) return
    pending.push(raw)
    dispatchNext()
  }

  window.__PODIUM_DELIVER_NATIVE_OPEN__ = enqueue
  window.__PODIUM_NATIVE_OPEN_ACK__ = (raw) => {
    if (!inFlight || pending[0] !== raw) return
    pending.shift()
    inFlight = false
    dispatchNext()
  }

  window.__PODIUM_NATIVE_OPEN_READY__ = (next = true) => {
    if (next === false) {
      ready = false
      // The page retains ownership until ACK. A new host must receive the
      // unacknowledged head again after the old listener disappears.
      inFlight = false
      return
    }
    ready = true
    dispatchNext()
  }
})()
