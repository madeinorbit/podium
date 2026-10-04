# OLD versus NEW whole-app measurements

Measurement in progress. No result currently establishes whether the MobX rewrite was worth it.

OLD is `5e3ece5cd68c5fbd7dbd8b1dcfa6d92a35f42cbb`. The first NEW arm is pinned to `22b676a741918c8c11a84aa485a37bb31595a7cc`, the integration tip at the start of this comparison. A later old-store-deletion landing will be recorded as a distinct NEW revision.

Captures use dedicated flatblock checkouts, production browser builds, the shared synthetic corpus at 1x and 4x, separate foreground arm runs in OLD/NEW order, and host load recorded for each run. Timing leases are acquired on ludovico and released after each capture; heap-only captures use the meter lease. Product code is unchanged. The final report will distinguish unavailable actions, failed captures, synthetic workload limits and measured regressions.
