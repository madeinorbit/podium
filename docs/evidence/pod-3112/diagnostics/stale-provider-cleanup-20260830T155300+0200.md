# POD-3112 stale provider cleanup

At 2026-08-30 15:53 CEST, `/proc` environment, cwd, and command-line inspection proved six stale processes belonged only to named instances `p3112-a7a-proof-0830e`, `p3112-a7a-0de0e5-r2`, and `p3112-a7a-ncr1`. The exact owned PIDs were `48156`, `48157`, `244944`, `245198`, `245200`, and `3995232`; they covered the named instances' OpenCode provider and attach/abduco processes.

Those six PIDs were terminated and a second full `/proc` environment scan found no process for any of the three named instances. No default/operator process, unrelated OpenCode session, state file, or listener was touched.

This cleanup request arrived after the fresh `3b62bca` A7a run had already completed and torn down its own scope. It therefore does not change that run's unscored verdict, but removes the older owned residue before any future fresh rig.
