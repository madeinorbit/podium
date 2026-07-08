// Moved to @podium/core (Phase 3 step 4): the state dir, local machine id and
// daemon secret are shared runtime infra (server, daemon entry, CLI). Re-exported
// here so apps/server import sites stay stable.
export {
  LOCAL_MACHINE_ID,
  LOCAL_PLACEHOLDER,
  readOrCreateDaemonSecret,
  stateDir,
} from '@podium/core/local-machine'
