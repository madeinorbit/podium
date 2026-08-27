# POD-2919 opencode acceptance drive

This rig drives the ten cells assigned to the unowned opencode column. It uses
one named instance (`oc2919`), one web bundle, serial cells, and a distinct
probe CWD for every cell because opencode keys its store by CWD. Every reading
records the CWD requested, the CWD observed from the spawned process, the bound
driver, server/daemon/web pins, a positive control, disk and host snapshots.

The headless arm is the normal `opencode-server/server` binding. A10 also
switches the same named instance to `PODIUM_RUNTIME_DRIVER=generic-pty` and
records the deliberate `generic-pty/terminal` demotion.
