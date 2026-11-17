// The settings-frame stubs, plus the session commands the exited bar's button reads
// (the "before" scene of the session credentials harness, epic Task 18).
export * from './settings-frame-core'

const noop = async () => {}
export const useCommands = () => ({
  machines: { rename: noop, setUpdateChannel: noop },
  sessions: { resume: noop, killSession: noop },
})
