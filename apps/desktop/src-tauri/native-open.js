(() => {
  const pending = []
  let ready = false
  const dispatch = (raw) =>
    window.dispatchEvent(new CustomEvent('podium:native-open', { detail: raw }))

  window.__PODIUM_DELIVER_NATIVE_OPEN__ = (raw) => {
    if (typeof raw !== 'string') return
    if (ready) dispatch(raw)
    else pending.push(raw)
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
