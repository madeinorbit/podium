# OLD versus NEW whole-app measurements

CURRENT at 96f705cd4e is a mixed result at 1x: session switching improves 802→389 ms, mark-read 925→139 ms, and issue-page opening 122→73 ms. Cold startup is slower (2291→3391 ms), warm-data reload is slower (1068→2551 ms), and populated project expansion is slower (113→252 ms). This is the first matched pair: eight unprofiled observations per ordinary action and four per startup case. The second pair, 4x, phone, heap and source attribution remain pending, so the whole-app verdict is still open. OLD phone refuses the shared corpus; no relative phone win is established.

## Compared applications

- **NEW**: `1aa0ec71f68c5c6569560798db00a82a1db9f82d`
- **NEW-CURRENT**: `96f705cd4ee836646d1d4539f411c307b5d6eab5`
- **OLD**: `5e3ece5cd68c5fbd7dbd8b1dcfa6d92a35f42cbb`

OLD corpus seed 4443: 4,867 issues and 4,304 sessions at 1x; 19,468 issues and 17,216 sessions at 4x. Two real isolated control issues and their live agents exercise mutations. OLD controls are matched to their contemporary NEW build using comparisonArm; later OLD controls are not pooled into the earlier NEW comparison. Both arms consume the same serialized semantic corpus; the per-run digest proves the match. OLD receives its legacy issue and issue-projection rows; NEW receives normalized issue/session personal state and git/machine facts. Optional null strings are omitted to satisfy the production wire schema.

Performance evidence: 12 completed measurement runs and 4 failed measurement runs. 1 failed run(s) retain a separately completed action phase; their failed background preparation contributes no CPU windows. 43 calibration, superseded or diagnostic runs are retained separately and excluded from comparisons.

This is a comparison of shipped application revisions, including their other changes and different data representations. It does not isolate MobX as the sole cause. The operator requested NEW be repinned from 22b676a741 to 1aa0ec71f6 during collection, and later requested the current dev/mw operator build be compared first; it is pinned at build time to 96f705cd4e. The deletion revision e22a8b6bd9 remains a separate named snapshot. The earlier 22b676 captures are retained as superseded evidence and do not enter the verdict.

## Latency, milliseconds

Lower is better. Percent change is `(NEW / OLD − 1) × 100`. Percentiles use nearest rank; median averages the middle pair. Profiled samples are excluded. Cached phone Work can return using only composited pixels: its boundary is DrawFrame when no new raster Paint occurs, and its CPU boundary is the last completed main-thread trace event before that frame, a conservative lower bound if work overlaps the frame; wider CDP task CPU also remains raw. Differences within ±10% are labelled no clear improvement; this is a reporting band, not a statistical confidence interval. With 4, 8 or 16 observations, nearest-rank p95 equals the maximum; it is a limited tail estimate, not an independent tail measurement.

| Surface | Scale | Action | NEW arm | OLD n | NEW n | OLD median | NEW median | OLD p95 | NEW p95 | Median change | p95 change | OLD max | NEW max | NEW boundary | Verdict |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| web | 1 | app-cold-start | new-current | 4 | 4 | 2,291.5 | 3,391.3 | 2,786.9 | 3,511.8 | 48.0% | 26.0% | 2,786.9 | 3,511.8 | Paint | slower |
| web | 1 | app-warm-start | new-current | 4 | 4 | 1,068.0 | 2,551.4 | 1,432.9 | 2,716.0 | 138.9% | 89.5% | 1,432.9 | 2,716.0 | Paint | slower |
| web | 1 | board-open | new-current | 8 | 8 | 308.1 | 404.4 | 322.3 | 597.8 | 31.3% | 85.5% | 322.3 | 597.8 | Paint | slower |
| web | 1 | board-search | new-current | 8 | 8 | 82.7 | 89.5 | 100.4 | 140.8 | 8.2% | 40.2% | 100.4 | 140.8 | Paint | similar median, worse tail |
| web | 1 | command-palette | new-current | 8 | 8 | 127.4 | 97.3 | 416.9 | 417.5 | -23.6% | 0.2% | 416.9 | 417.5 | Paint | faster |
| web | 1 | dock-close | new-current | 8 | 8 | 89.0 | 66.1 | 119.9 | 81.1 | -25.7% | -32.3% | 119.9 | 81.1 | Paint | faster |
| web | 1 | dock-open | new-current | 8 | 8 | 109.9 | 84.0 | 137.6 | 108.4 | -23.5% | -21.2% | 137.6 | 108.4 | Paint | faster |
| web | 1 | flight-deck-collapse | new-current | 8 | 8 | 36.8 | 55.0 | 57.2 | 85.3 | 49.4% | 49.2% | 57.2 | 85.3 | Paint | slower |
| web | 1 | flight-deck-expand | new-current | 8 | 8 | 51.8 | 48.9 | 56.3 | 60.5 | -5.7% | 7.6% | 56.3 | 60.5 | Paint | no clear improvement |
| web | 1 | header-menu | new-current | 8 | 8 | 45.3 | 36.5 | 103.2 | 61.2 | -19.4% | -40.7% | 103.2 | 61.2 | Paint | faster |
| web | 1 | issue-page-open | new-current | 8 | 8 | 121.9 | 73.0 | 208.5 | 119.4 | -40.1% | -42.7% | 208.5 | 119.4 | Paint | faster |
| web | 1 | issue-picker-search | new-current | 8 | 8 | 30.0 | 69.8 | 56.7 | 141.3 | 132.6% | 149.3% | 56.7 | 141.3 | Paint | slower |
| web | 1 | issue-rename | new-current | 8 | 8 | 276.8 | 35.3 | 610.0 | 50.0 | -87.3% | -91.8% | 610.0 | 50.0 | Paint | faster |
| web | 1 | large-mission-switch | new-current | 8 | 8 | 768.5 | 572.9 | 1,310.6 | 1,251.3 | -25.5% | -4.5% | 1,310.6 | 1,251.3 | Paint | faster |
| web | 1 | mark-read | new-current | 8 | 8 | 925.3 | 139.0 | 2,144.8 | 192.7 | -85.0% | -91.0% | 2,144.8 | 192.7 | Paint | faster |
| web | 1 | mission-switch | new-current | 8 | 8 | 380.3 | 235.3 | 427.1 | 267.3 | -38.1% | -37.4% | 427.1 | 267.3 | Paint | faster |
| web | 1 | session-composer-typing | new-current | 0 | 0 | — | — | — | — | — | — | — | — |  | not measured |
| web | 1 | session-switch | new-current | 8 | 8 | 802.4 | 388.8 | 1,059.8 | 770.1 | -51.5% | -27.3% | 1,059.8 | 770.1 | Paint | faster |
| web | 1 | sidebar-collapse | new-current | 8 | 8 | 82.4 | 97.4 | 110.4 | 122.5 | 18.2% | 11.0% | 110.4 | 122.5 | Paint | slower |
| web | 1 | sidebar-drag-drop | new-current | 8 | 8 | 228.4 | 93.6 | 261.5 | 195.0 | -59.0% | -25.4% | 261.5 | 195.0 | Paint | faster |
| web | 1 | sidebar-drag-start | new-current | 8 | 8 | 23.6 | 35.3 | 31.6 | 42.7 | 49.4% | 35.5% | 31.6 | 42.7 | Paint | slower |
| web | 1 | sidebar-expand | new-current | 8 | 8 | 160.9 | 198.7 | 189.6 | 215.9 | 23.5% | 13.9% | 189.6 | 215.9 | Paint | slower |
| web | 1 | sidebar-group-collapse | new-current | 8 | 8 | 44.6 | 82.3 | 59.5 | 88.0 | 84.6% | 47.9% | 59.5 | 88.0 | Paint | slower |
| web | 1 | sidebar-group-expand | new-current | 8 | 8 | 112.7 | 252.4 | 131.6 | 321.1 | 123.9% | 144.0% | 131.6 | 321.1 | Paint | slower |
| web | 1 | sidebar-select | new-current | 8 | 8 | 264.7 | 168.0 | 433.3 | 256.2 | -36.5% | -40.9% | 433.3 | 256.2 | Paint | faster |
| web | 1 | superagent-composer-typing | new-current | 8 | 8 | 12.8 | 11.0 | 20.2 | 58.5 | -14.6% | 190.0% | 20.2 | 58.5 | Paint | faster median, worse tail |
| phone | 1 | app-cold-start | new | 0 | 8 | — | 4,032.0 | — | 5,152.1 | — | — | — | 5,152.1 | Paint | not comparable |
| phone | 1 | app-warm-start | new | 0 | 8 | — | 2,701.5 | — | 3,921.7 | — | — | — | 3,921.7 | Paint | not comparable |
| phone | 1 | phone-composer-typing | new | 0 | 16 | — | 14.9 | — | 21.5 | — | — | — | 21.5 | Paint | not comparable |
| phone | 1 | phone-inbox | new | 0 | 0 | — | — | — | — | — | — | — | — |  | not measured |
| phone | 1 | phone-issue-open | new | 0 | 16 | — | 95.8 | — | 140.0 | — | — | — | 140.0 | Paint | not comparable |
| phone | 1 | phone-issue-picker-search | new | 0 | 16 | — | 19.2 | — | 35.0 | — | — | — | 35.0 | Paint | not comparable |
| phone | 1 | phone-issue-rename | new | 0 | 16 | — | 25.0 | — | 48.0 | — | — | — | 48.0 | Paint | not comparable |
| phone | 1 | phone-issue-screen | new | 0 | 16 | — | 420.2 | — | 733.9 | — | — | — | 733.9 | Paint | not comparable |
| phone | 1 | phone-long-press | new | 0 | 16 | — | 565.0 | — | 639.1 | — | — | — | 639.1 | Paint | not comparable |
| phone | 1 | phone-mission-details | new | 0 | 16 | — | 119.3 | — | 308.6 | — | — | — | 308.6 | Paint | not comparable |
| phone | 1 | phone-mission-open | new | 0 | 16 | — | 149.6 | — | 210.9 | — | — | — | 210.9 | Paint | not comparable |
| phone | 1 | phone-work-screen | new | 0 | 16 | — | 339.4 | — | 500.4 | — | — | — | 500.4 | DrawFrame (compositor, no new raster Paint), Paint | not comparable |
| phone | 1 | phone-work-search | new | 0 | 16 | — | 12.7 | — | 25.4 | — | — | — | 25.4 | Paint | not comparable |
| phone | 4 | app-cold-start | new | 0 | 4 | — | 14,628.8 | — | 16,215.5 | — | — | — | 16,215.5 | Paint | not comparable |
| phone | 4 | app-warm-start | new | 0 | 4 | — | 11,243.9 | — | 12,435.1 | — | — | — | 12,435.1 | Paint | not comparable |
| phone | 4 | phone-composer-typing | new | 0 | 8 | — | 13.8 | — | 19.7 | — | — | — | 19.7 | Paint | not comparable |
| phone | 4 | phone-inbox | new | 0 | 0 | — | — | — | — | — | — | — | — |  | not measured |
| phone | 4 | phone-issue-open | new | 0 | 8 | — | 105.7 | — | 198.6 | — | — | — | 198.6 | Paint | not comparable |
| phone | 4 | phone-issue-picker-search | new | 0 | 8 | — | 23.0 | — | 26.0 | — | — | — | 26.0 | Paint | not comparable |
| phone | 4 | phone-issue-rename | new | 0 | 8 | — | 23.0 | — | 23.6 | — | — | — | 23.6 | Paint | not comparable |
| phone | 4 | phone-issue-screen | new | 0 | 8 | — | 1,654.2 | — | 1,959.1 | — | — | — | 1,959.1 | Paint | not comparable |
| phone | 4 | phone-long-press | new | 0 | 8 | — | 593.5 | — | 629.4 | — | — | — | 629.4 | Paint | not comparable |
| phone | 4 | phone-mission-details | new | 0 | 8 | — | 126.7 | — | 158.0 | — | — | — | 158.0 | Paint | not comparable |
| phone | 4 | phone-mission-open | new | 0 | 8 | — | 201.7 | — | 270.1 | — | — | — | 270.1 | Paint | not comparable |
| phone | 4 | phone-work-screen | new | 0 | 8 | — | 851.9 | — | 1,012.4 | — | — | — | 1,012.4 | DrawFrame (compositor, no new raster Paint), Paint | not comparable |
| phone | 4 | phone-work-search | new | 0 | 8 | — | 16.5 | — | 19.4 | — | — | — | 19.4 | Paint | not comparable |
| web | 1 | app-cold-start | new | 8 | 8 | 2,267.8 | 3,585.2 | 3,421.0 | 5,357.3 | 58.1% | 56.6% | 3,421.0 | 5,357.3 | Paint | slower |
| web | 1 | app-warm-start | new | 8 | 8 | 1,173.1 | 2,185.1 | 1,360.1 | 3,339.3 | 86.3% | 145.5% | 1,360.1 | 3,339.3 | Paint | slower |
| web | 1 | board-open | new | 16 | 16 | 329.2 | 391.8 | 586.6 | 594.9 | 19.0% | 1.4% | 586.6 | 594.9 | Paint | slower |
| web | 1 | board-search | new | 16 | 16 | 58.2 | 120.4 | 127.6 | 174.7 | 106.9% | 37.0% | 127.6 | 174.7 | Paint | slower |
| web | 1 | command-palette | new | 16 | 16 | 105.3 | 154.7 | 483.8 | 450.4 | 47.0% | -6.9% | 483.8 | 450.4 | Paint | slower |
| web | 1 | dock-close | new | 16 | 16 | 73.4 | 60.2 | 91.0 | 120.1 | -17.9% | 31.9% | 91.0 | 120.1 | Paint | faster median, worse tail |
| web | 1 | dock-open | new | 16 | 16 | 87.5 | 85.1 | 117.9 | 189.3 | -2.7% | 60.5% | 117.9 | 189.3 | Paint | similar median, worse tail |
| web | 1 | flight-deck-collapse | new | 16 | 16 | 42.6 | 41.9 | 50.1 | 48.0 | -1.5% | -4.1% | 50.1 | 48.0 | Paint | no clear improvement |
| web | 1 | flight-deck-expand | new | 16 | 16 | 60.0 | 37.6 | 75.1 | 55.6 | -37.3% | -25.9% | 75.1 | 55.6 | Paint | faster |
| web | 1 | header-menu | new | 16 | 16 | 30.7 | 26.1 | 63.6 | 51.8 | -14.8% | -18.6% | 63.6 | 51.8 | Paint | faster |
| web | 1 | issue-page-open | new | 16 | 16 | 109.4 | 235.6 | 137.3 | 345.3 | 115.4% | 151.4% | 137.3 | 345.3 | Paint | slower |
| web | 1 | issue-picker-search | new | 16 | 16 | 24.3 | 29.9 | 71.6 | 61.5 | 22.8% | -14.0% | 71.6 | 61.5 | Paint | slower |
| web | 1 | issue-rename | new | 16 | 16 | 237.5 | 57.6 | 451.5 | 104.2 | -75.7% | -76.9% | 451.5 | 104.2 | Paint | faster |
| web | 1 | large-mission-switch | new | 8 | 8 | 735.1 | 802.5 | 1,660.1 | 1,589.2 | 9.2% | -4.3% | 1,660.1 | 1,589.2 | Paint | no clear improvement |
| web | 1 | mark-read | new | 16 | 16 | 953.6 | 128.1 | 1,043.5 | 160.8 | -86.6% | -84.6% | 1,043.5 | 160.8 | Paint | faster |
| web | 1 | mission-switch | new | 16 | 16 | 407.5 | 223.4 | 528.6 | 258.1 | -45.2% | -51.2% | 528.6 | 258.1 | Paint | faster |
| web | 1 | session-composer-typing | new | 0 | 0 | — | — | — | — | — | — | — | — |  | not measured |
| web | 1 | session-switch | new | 16 | 16 | 791.0 | 418.4 | 899.2 | 564.0 | -47.1% | -37.3% | 899.2 | 564.0 | Paint | faster |
| web | 1 | sidebar-collapse | new | 16 | 16 | 88.2 | 100.8 | 134.8 | 129.6 | 14.3% | -3.8% | 134.8 | 129.6 | Paint | slower |
| web | 1 | sidebar-drag-drop | new | 16 | 16 | 247.2 | 111.6 | 310.9 | 131.0 | -54.8% | -57.8% | 310.9 | 131.0 | Paint | faster |
| web | 1 | sidebar-drag-start | new | 16 | 16 | 27.0 | 28.4 | 41.8 | 41.4 | 5.2% | -1.0% | 41.8 | 41.4 | Paint | no clear improvement |
| web | 1 | sidebar-expand | new | 16 | 16 | 170.9 | 192.0 | 208.8 | 234.1 | 12.4% | 12.1% | 208.8 | 234.1 | Paint | slower |
| web | 1 | sidebar-group-collapse | new | 16 | 16 | 47.1 | 56.4 | 60.9 | 89.3 | 19.7% | 46.5% | 60.9 | 89.3 | Paint | slower |
| web | 1 | sidebar-group-expand | new | 16 | 16 | 91.4 | 203.9 | 115.3 | 229.8 | 123.0% | 99.3% | 115.3 | 229.8 | Paint | slower |
| web | 1 | sidebar-select | new | 16 | 16 | 297.8 | 148.6 | 390.6 | 214.7 | -50.1% | -45.0% | 390.6 | 214.7 | Paint | faster |
| web | 1 | superagent-composer-typing | new | 16 | 16 | 13.6 | 14.4 | 29.8 | 19.3 | 6.0% | -35.3% | 29.8 | 19.3 | Paint | no clear improvement |
| web | 4 | app-cold-start | new | 8 | 8 | 7,743.8 | 12,446.9 | 10,001.6 | 20,524.9 | 60.7% | 105.2% | 10,001.6 | 20,524.9 | Paint | slower |
| web | 4 | app-warm-start | new | 8 | 8 | 4,407.1 | 9,276.2 | 4,754.7 | 11,444.9 | 110.5% | 140.7% | 4,754.7 | 11,444.9 | Paint | slower |
| web | 4 | board-open | new | 16 | 16 | 647.7 | 1,098.9 | 2,926.6 | 1,595.2 | 69.7% | -45.5% | 2,926.6 | 1,595.2 | Paint | slower |
| web | 4 | board-search | new | 16 | 16 | 158.2 | 292.7 | 284.5 | 443.3 | 85.1% | 55.8% | 284.5 | 443.3 | Paint | slower |
| web | 4 | command-palette | new | 16 | 16 | 304.9 | 461.6 | 698.7 | 1,554.1 | 51.4% | 122.4% | 698.7 | 1,554.1 | Paint | slower |
| web | 4 | dock-close | new | 16 | 16 | 235.0 | 225.4 | 419.2 | 516.9 | -4.1% | 23.3% | 419.2 | 516.9 | Paint | similar median, worse tail |
| web | 4 | dock-open | new | 16 | 16 | 286.6 | 702.6 | 2,290.3 | 1,103.8 | 145.1% | -51.8% | 2,290.3 | 1,103.8 | Paint | slower |
| web | 4 | flight-deck-collapse | new | 16 | 16 | 115.1 | 94.1 | 256.2 | 157.6 | -18.2% | -38.5% | 256.2 | 157.6 | Paint | faster |
| web | 4 | flight-deck-expand | new | 16 | 16 | 162.9 | 96.2 | 199.9 | 126.8 | -40.9% | -36.6% | 199.9 | 126.8 | Paint | faster |
| web | 4 | header-menu | new | 16 | 16 | 69.5 | 64.2 | 145.2 | 112.4 | -7.6% | -22.6% | 145.2 | 112.4 | Paint | no clear improvement |
| web | 4 | issue-page-open | new | 16 | 16 | 361.4 | 1,443.1 | 445.9 | 2,125.5 | 299.3% | 376.7% | 445.9 | 2,125.5 | Paint | slower |
| web | 4 | issue-picker-search | new | 16 | 16 | 44.7 | 80.8 | 70.6 | 107.2 | 81.0% | 51.8% | 70.6 | 107.2 | Paint | slower |
| web | 4 | issue-rename | new | 16 | 16 | 2,189.0 | 220.5 | 5,412.9 | 605.0 | -89.9% | -88.8% | 5,412.9 | 605.0 | Paint | faster |
| web | 4 | large-mission-switch | new | 8 | 16 | 3,663.7 | 1,524.3 | 5,198.1 | 3,696.8 | -58.4% | -28.9% | 5,198.1 | 3,696.8 | Paint | faster |
| web | 4 | mark-read | new | 16 | 16 | 7,547.8 | 1,323.3 | 9,027.6 | 1,717.8 | -82.5% | -81.0% | 9,027.6 | 1,717.8 | Paint | faster |
| web | 4 | mission-switch | new | 16 | 16 | 2,500.8 | 730.1 | 3,680.6 | 1,021.9 | -70.8% | -72.2% | 3,680.6 | 1,021.9 | Paint | faster |
| web | 4 | session-composer-typing | new | 0 | 0 | — | — | — | — | — | — | — | — |  | not measured |
| web | 4 | session-switch | new | 16 | 16 | 5,617.6 | 920.2 | 8,501.3 | 1,335.0 | -83.6% | -84.3% | 8,501.3 | 1,335.0 | Paint | faster |
| web | 4 | sidebar-collapse | new | 16 | 16 | 308.5 | 401.7 | 416.6 | 494.4 | 30.2% | 18.7% | 416.6 | 494.4 | Paint | slower |
| web | 4 | sidebar-drag-drop | new | 16 | 16 | 1,762.5 | 395.5 | 3,298.8 | 434.5 | -77.6% | -86.8% | 3,298.8 | 434.5 | Paint | faster |
| web | 4 | sidebar-drag-start | new | 16 | 16 | 79.5 | 96.8 | 101.2 | 114.8 | 21.7% | 13.5% | 101.2 | 114.8 | Paint | slower |
| web | 4 | sidebar-expand | new | 16 | 16 | 759.2 | 1,005.0 | 1,201.2 | 1,450.3 | 32.4% | 20.7% | 1,201.2 | 1,450.3 | Paint | slower |
| web | 4 | sidebar-group-collapse | new | 16 | 16 | 110.7 | 145.1 | 137.7 | 294.7 | 31.1% | 114.1% | 137.7 | 294.7 | Paint | slower |
| web | 4 | sidebar-group-expand | new | 16 | 16 | 235.5 | 594.4 | 270.1 | 1,829.7 | 152.4% | 577.3% | 270.1 | 1,829.7 | Paint | slower |
| web | 4 | sidebar-select | new | 8 | 16 | 2,093.2 | 495.9 | 2,584.5 | 1,174.2 | -76.3% | -54.6% | 2,584.5 | 1,174.2 | Paint | faster |
| web | 4 | superagent-composer-typing | new | 16 | 16 | 27.2 | 30.2 | 35.1 | 55.1 | 10.9% | 57.1% | 35.1 | 55.1 | Paint | slower |

## Main-thread work per action

Main-thread CPU uses Chromium trace thread timestamps (tts/tdur), from the trusted input handler to the qualifying Paint end. It excludes OS descheduling; click latency includes the event queue and waiting. Startup CPU starts at the initialization script, slightly after navigation begins. Layout CPU is the union of Layout and UpdateLayoutTree thread durations in that interval and overlaps total CPU. Task busy wall time and wider CDP polling-window deltas remain in raw data. Source-map profiles separately estimate store/derive and React work; never add overlapping categories. [Chromium performance-agent implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc).

| Surface | Scale | Action | NEW arm | OLD CPU median | NEW CPU median | Median change | OLD CPU p95 | NEW CPU p95 | OLD CPU max | NEW CPU max | OLD layout CPU | NEW layout CPU |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| web | 1 | app-cold-start | new-current | 1,700.1 | 2,780.7 | 63.6% | 1,957.0 | 2,811.0 | 1,957.0 | 2,811.0 | 92.8 | 82.4 |
| web | 1 | app-warm-start | new-current | 790.0 | 1,741.9 | 120.5% | 915.9 | 1,932.5 | 915.9 | 1,932.5 | 61.5 | 55.5 |
| web | 1 | board-open | new-current | 249.1 | 316.6 | 27.1% | 268.6 | 350.5 | 268.6 | 350.5 | 60.5 | 64.2 |
| web | 1 | board-search | new-current | 64.3 | 89.1 | 38.5% | 84.7 | 136.1 | 84.7 | 136.1 | 9.3 | 8.1 |
| web | 1 | command-palette | new-current | 93.2 | 79.4 | -14.9% | 235.3 | 363.8 | 235.3 | 363.8 | 6.8 | 6.7 |
| web | 1 | dock-close | new-current | 60.1 | 52.0 | -13.5% | 82.1 | 57.9 | 82.1 | 57.9 | 3.6 | 3.1 |
| web | 1 | dock-open | new-current | 76.2 | 64.1 | -15.8% | 97.5 | 74.5 | 97.5 | 74.5 | 3.7 | 3.8 |
| web | 1 | flight-deck-collapse | new-current | 30.9 | 42.4 | 37.5% | 44.8 | 56.9 | 44.8 | 56.9 | 1.6 | 3.5 |
| web | 1 | flight-deck-expand | new-current | 41.9 | 34.6 | -17.3% | 47.5 | 43.2 | 47.5 | 43.2 | 4.4 | 4.5 |
| web | 1 | header-menu | new-current | 21.5 | 23.6 | 9.7% | 50.1 | 46.5 | 50.1 | 46.5 | 4.3 | 4.5 |
| web | 1 | issue-page-open | new-current | 83.3 | 59.9 | -28.1% | 122.4 | 98.7 | 122.4 | 98.7 | 28.5 | 28.2 |
| web | 1 | issue-picker-search | new-current | 22.2 | 41.8 | 87.9% | 34.5 | 54.7 | 34.5 | 54.7 | 3.8 | 5.5 |
| web | 1 | issue-rename | new-current | 219.1 | 28.8 | -86.9% | 254.2 | 35.1 | 254.2 | 35.1 | 2.3 | 2.2 |
| web | 1 | large-mission-switch | new-current | 664.8 | 539.8 | -18.8% | 1,197.9 | 1,178.1 | 1,197.9 | 1,178.1 | 139.4 | 167.2 |
| web | 1 | mark-read | new-current | 883.2 | 86.8 | -90.2% | 1,541.6 | 99.5 | 1,541.6 | 99.5 | 6.3 | 4.1 |
| web | 1 | mission-switch | new-current | 346.7 | 189.6 | -45.3% | 366.1 | 221.9 | 366.1 | 221.9 | 52.6 | 57.2 |
| web | 1 | session-composer-typing | new-current | — | — | — | — | — | — | — | — | — |
| web | 1 | session-switch | new-current | 746.3 | 149.7 | -79.9% | 867.5 | 360.8 | 867.5 | 360.8 | 33.5 | 33.3 |
| web | 1 | sidebar-collapse | new-current | 77.3 | 88.0 | 13.9% | 90.5 | 112.3 | 90.5 | 112.3 | 16.7 | 15.1 |
| web | 1 | sidebar-drag-drop | new-current | 27.9 | 29.9 | 7.1% | 40.1 | 115.4 | 40.1 | 115.4 | 3.6 | 3.6 |
| web | 1 | sidebar-drag-start | new-current | 20.7 | 28.2 | 36.5% | 26.2 | 32.2 | 26.2 | 32.2 | 1.4 | 1.5 |
| web | 1 | sidebar-expand | new-current | 156.5 | 180.8 | 15.5% | 184.6 | 187.3 | 184.6 | 187.3 | 41.9 | 39.5 |
| web | 1 | sidebar-group-collapse | new-current | 37.8 | 61.6 | 63.0% | 45.0 | 66.5 | 45.0 | 66.5 | 1.4 | 1.6 |
| web | 1 | sidebar-group-expand | new-current | 109.0 | 221.7 | 103.5% | 119.9 | 264.6 | 119.9 | 264.6 | 25.8 | 25.5 |
| web | 1 | sidebar-select | new-current | 252.5 | 129.7 | -48.6% | 329.1 | 166.3 | 329.1 | 166.3 | 36.4 | 38.7 |
| web | 1 | superagent-composer-typing | new-current | 11.5 | 9.9 | -13.9% | 13.6 | 28.9 | 13.6 | 28.9 | 2.1 | 2.3 |
| phone | 1 | app-cold-start | new | — | 3,153.1 | — | — | 3,902.1 | — | 3,902.1 | — | 44.4 |
| phone | 1 | app-warm-start | new | — | 2,015.8 | — | — | 2,258.4 | — | 2,258.4 | — | 57.3 |
| phone | 1 | phone-composer-typing | new | — | 14.0 | — | — | 17.6 | — | 17.6 | — | 1.4 |
| phone | 1 | phone-inbox | new | — | — | — | — | — | — | — | — | — |
| phone | 1 | phone-issue-open | new | — | 67.1 | — | — | 104.1 | — | 104.1 | — | 12.3 |
| phone | 1 | phone-issue-picker-search | new | — | 17.5 | — | — | 25.4 | — | 25.4 | — | 1.1 |
| phone | 1 | phone-issue-rename | new | — | 20.6 | — | — | 40.8 | — | 40.8 | — | 1.4 |
| phone | 1 | phone-issue-screen | new | — | 366.2 | — | — | 429.0 | — | 429.0 | — | 4.1 |
| phone | 1 | phone-long-press | new | — | 469.7 | — | — | 515.1 | — | 515.1 | — | 86.4 |
| phone | 1 | phone-mission-details | new | — | 113.0 | — | — | 191.5 | — | 191.5 | — | 52.4 |
| phone | 1 | phone-mission-open | new | — | 113.9 | — | — | 159.8 | — | 159.8 | — | 14.0 |
| phone | 1 | phone-work-screen | new | — | 370.5 | — | — | 370.5 | — | 370.5 | — | 22.4 |
| phone | 1 | phone-work-search | new | — | 11.6 | — | — | 22.5 | — | 22.5 | — | 1.5 |
| phone | 4 | app-cold-start | new | — | 10,415.7 | — | — | 10,927.2 | — | 10,927.2 | — | 61.6 |
| phone | 4 | app-warm-start | new | — | 7,690.9 | — | — | 8,272.1 | — | 8,272.1 | — | 70.6 |
| phone | 4 | phone-composer-typing | new | — | 13.6 | — | — | 17.2 | — | 17.2 | — | 1.3 |
| phone | 4 | phone-inbox | new | — | — | — | — | — | — | — | — | — |
| phone | 4 | phone-issue-open | new | — | 80.4 | — | — | 156.7 | — | 156.7 | — | 13.6 |
| phone | 4 | phone-issue-picker-search | new | — | 22.8 | — | — | 25.8 | — | 25.8 | — | 1.1 |
| phone | 4 | phone-issue-rename | new | — | 20.4 | — | — | 20.9 | — | 20.9 | — | 1.3 |
| phone | 4 | phone-issue-screen | new | — | 1,576.9 | — | — | 1,598.9 | — | 1,598.9 | — | 6.8 |
| phone | 4 | phone-long-press | new | — | 511.6 | — | — | 520.7 | — | 520.7 | — | 121.6 |
| phone | 4 | phone-mission-details | new | — | 122.2 | — | — | 152.3 | — | 152.3 | — | 59.9 |
| phone | 4 | phone-mission-open | new | — | 170.6 | — | — | 234.7 | — | 234.7 | — | 17.2 |
| phone | 4 | phone-work-screen | new | — | 894.0 | — | — | 966.4 | — | 966.4 | — | 27.8 |
| phone | 4 | phone-work-search | new | — | 15.5 | — | — | 17.1 | — | 17.1 | — | 1.5 |
| web | 1 | app-cold-start | new | 1,789.0 | 2,918.7 | 63.1% | 2,590.9 | 3,512.8 | 2,590.9 | 3,512.8 | 93.8 | 91.3 |
| web | 1 | app-warm-start | new | 813.0 | 1,786.5 | 119.7% | 875.3 | 2,148.2 | 875.3 | 2,148.2 | 68.0 | 57.1 |
| web | 1 | board-open | new | 281.0 | 359.6 | 28.0% | 347.6 | 406.5 | 347.6 | 406.5 | 67.1 | 63.6 |
| web | 1 | board-search | new | 56.8 | 117.1 | 106.3% | 106.5 | 161.4 | 106.5 | 161.4 | 8.2 | 8.7 |
| web | 1 | command-palette | new | 100.2 | 148.7 | 48.4% | 427.2 | 397.0 | 427.2 | 397.0 | 7.5 | 7.2 |
| web | 1 | dock-close | new | 60.0 | 48.8 | -18.7% | 74.5 | 99.7 | 74.5 | 99.7 | 3.3 | 3.0 |
| web | 1 | dock-open | new | 76.1 | 70.9 | -6.8% | 90.2 | 181.8 | 90.2 | 181.8 | 3.8 | 3.6 |
| web | 1 | flight-deck-collapse | new | 35.0 | 35.6 | 1.6% | 41.3 | 40.5 | 41.3 | 40.5 | 1.8 | 3.1 |
| web | 1 | flight-deck-expand | new | 46.2 | 28.3 | -38.6% | 58.4 | 41.5 | 58.4 | 41.5 | 5.0 | 3.8 |
| web | 1 | header-menu | new | 20.8 | 19.3 | -7.3% | 48.4 | 40.1 | 48.4 | 40.1 | 4.1 | 4.0 |
| web | 1 | issue-page-open | new | 92.4 | 223.7 | 142.1% | 118.7 | 311.8 | 118.7 | 311.8 | 30.0 | 27.0 |
| web | 1 | issue-picker-search | new | 23.9 | 27.5 | 15.1% | 37.7 | 37.8 | 37.7 | 37.8 | 4.6 | 4.7 |
| web | 1 | issue-rename | new | 227.6 | 52.1 | -77.1% | 274.8 | 62.4 | 274.8 | 62.4 | 2.4 | 2.0 |
| web | 1 | large-mission-switch | new | 712.1 | 783.1 | 10.0% | 1,561.0 | 1,548.3 | 1,561.0 | 1,548.3 | 148.2 | 257.4 |
| web | 1 | mark-read | new | 905.5 | 96.7 | -89.3% | 984.3 | 116.5 | 984.3 | 116.5 | 6.7 | 3.7 |
| web | 1 | mission-switch | new | 365.8 | 197.3 | -46.1% | 465.9 | 230.8 | 465.9 | 230.8 | 57.6 | 52.3 |
| web | 1 | session-composer-typing | new | — | — | — | — | — | — | — | — | — |
| web | 1 | session-switch | new | 685.9 | 185.7 | -72.9% | 856.8 | 443.6 | 856.8 | 443.6 | 33.6 | 30.1 |
| web | 1 | sidebar-collapse | new | 79.3 | 95.1 | 19.9% | 102.4 | 115.7 | 102.4 | 115.7 | 18.1 | 17.5 |
| web | 1 | sidebar-drag-drop | new | 27.1 | 24.3 | -10.0% | 49.6 | 38.5 | 49.6 | 38.5 | 3.8 | 3.6 |
| web | 1 | sidebar-drag-start | new | 22.0 | 24.9 | 13.4% | 28.9 | 35.5 | 28.9 | 35.5 | 1.5 | 1.5 |
| web | 1 | sidebar-expand | new | 166.0 | 187.4 | 12.9% | 195.0 | 229.1 | 195.0 | 229.1 | 43.2 | 43.2 |
| web | 1 | sidebar-group-collapse | new | 37.0 | 49.4 | 33.3% | 45.3 | 74.9 | 45.3 | 74.9 | 1.5 | 1.3 |
| web | 1 | sidebar-group-expand | new | 87.4 | 196.8 | 125.3% | 109.9 | 220.9 | 109.9 | 220.9 | 23.5 | 24.7 |
| web | 1 | sidebar-select | new | 280.2 | 131.4 | -53.1% | 339.4 | 187.8 | 339.4 | 187.8 | 38.2 | 38.1 |
| web | 1 | superagent-composer-typing | new | 12.9 | 14.1 | 9.5% | 22.7 | 17.6 | 22.7 | 17.6 | 2.5 | 3.5 |
| web | 4 | app-cold-start | new | 6,041.2 | 10,536.1 | 74.4% | 7,007.8 | 14,856.1 | 7,007.8 | 14,856.1 | 226.1 | 176.5 |
| web | 4 | app-warm-start | new | 3,399.7 | 7,697.5 | 126.4% | 3,644.6 | 8,475.5 | 3,644.6 | 8,475.5 | 187.5 | 140.1 |
| web | 4 | board-open | new | 569.6 | 905.0 | 58.9% | 726.8 | 1,155.1 | 726.8 | 1,155.1 | 144.0 | 147.3 |
| web | 4 | board-search | new | 157.9 | 284.9 | 80.5% | 274.8 | 441.2 | 274.8 | 441.2 | 13.3 | 14.6 |
| web | 4 | command-palette | new | 294.2 | 420.2 | 42.8% | 624.1 | 1,333.4 | 624.1 | 1,333.4 | 58.9 | 8.4 |
| web | 4 | dock-close | new | 180.7 | 175.2 | -3.0% | 301.5 | 307.3 | 301.5 | 307.3 | 5.4 | 5.6 |
| web | 4 | dock-open | new | 228.9 | 627.3 | 174.1% | 2,044.6 | 975.1 | 2,044.6 | 975.1 | 5.2 | 5.5 |
| web | 4 | flight-deck-collapse | new | 92.1 | 78.4 | -14.9% | 227.3 | 136.5 | 227.3 | 136.5 | 2.3 | 4.6 |
| web | 4 | flight-deck-expand | new | 126.8 | 59.0 | -53.5% | 156.7 | 85.3 | 156.7 | 85.3 | 6.6 | 5.3 |
| web | 4 | header-menu | new | 35.5 | 34.7 | -2.3% | 77.6 | 66.0 | 77.6 | 66.0 | 6.0 | 6.1 |
| web | 4 | issue-page-open | new | 316.4 | 1,387.1 | 338.4% | 373.1 | 1,921.4 | 373.1 | 1,921.4 | 96.5 | 96.4 |
| web | 4 | issue-picker-search | new | 41.5 | 77.9 | 87.5% | 60.9 | 101.2 | 60.9 | 101.2 | 6.7 | 7.8 |
| web | 4 | issue-rename | new | 2,119.7 | 208.3 | -90.2% | 2,836.0 | 435.4 | 2,836.0 | 435.4 | 4.2 | 4.1 |
| web | 4 | large-mission-switch | new | 3,143.9 | 1,425.9 | -54.6% | 4,374.0 | 3,451.2 | 4,374.0 | 3,451.2 | 235.5 | 406.9 |
| web | 4 | mark-read | new | 7,496.1 | 1,217.2 | -83.8% | 8,933.3 | 1,556.3 | 8,933.3 | 1,556.3 | 31.5 | 15.9 |
| web | 4 | mission-switch | new | 2,293.7 | 650.6 | -71.6% | 3,206.8 | 864.9 | 3,206.8 | 864.9 | 144.2 | 146.9 |
| web | 4 | session-composer-typing | new | — | — | — | — | — | — | — | — | — |
| web | 4 | session-switch | new | 5,476.1 | 713.8 | -87.0% | 8,413.1 | 1,253.3 | 8,413.1 | 1,253.3 | 106.9 | 108.8 |
| web | 4 | sidebar-collapse | new | 277.7 | 361.5 | 30.2% | 405.8 | 482.7 | 405.8 | 482.7 | 57.8 | 60.7 |
| web | 4 | sidebar-drag-drop | new | 94.2 | 54.5 | -42.2% | 496.7 | 94.9 | 496.7 | 94.9 | 12.3 | 7.4 |
| web | 4 | sidebar-drag-start | new | 69.2 | 83.2 | 20.3% | 83.8 | 98.4 | 83.8 | 98.4 | 2.2 | 2.2 |
| web | 4 | sidebar-expand | new | 716.3 | 957.8 | 33.7% | 1,183.4 | 1,429.7 | 1,183.4 | 1,429.7 | 156.8 | 160.0 |
| web | 4 | sidebar-group-collapse | new | 89.0 | 124.7 | 40.1% | 111.4 | 168.5 | 111.4 | 168.5 | 2.6 | 2.6 |
| web | 4 | sidebar-group-expand | new | 209.2 | 542.1 | 159.1% | 252.3 | 832.5 | 252.3 | 832.5 | 32.1 | 34.2 |
| web | 4 | sidebar-select | new | 1,933.9 | 396.1 | -79.5% | 2,215.5 | 922.1 | 2,215.5 | 922.1 | 112.4 | 126.7 |
| web | 4 | superagent-composer-typing | new | 24.9 | 28.8 | 15.9% | 32.9 | 54.8 | 32.9 | 54.8 | 4.2 | 7.6 |

## Sampled store and React attribution

Requested V8 sampling interval: 100 microseconds. Values below estimate CPU as measured renderer thread CPU multiplied by each category’s share of non-idle sampled stack wall time, during separately profiled handler-to-Paint windows. Stack slices start at the mark’s callTime (actual recorder execution), matching the thread-clock start; latency still begins at the backdated trusted-event timestamp and includes queueing. Any absent-callTime fallback is labelled in raw attribution. Sampling and OS descheduling can bias these allocations; they are not exclusive hardware counters. Profiled samples are excluded from latency statistics. Sampled wall durations also remain in raw attribution files. React render includes app derivations it calls; store/derive is an inclusive stack match and overlaps React. Commit includes layout effects and called native work; layout hardware CPU appears in the preceding table. Idle, unmapped and other samples are retained in cpu-attribution.json. No exact exclusive store or React hardware-CPU counters are claimed.

| Arm | Surface | Scale | Action | Profiles | Store/derive CPU estimate | React render CPU estimate | React commit CPU estimate | Unmapped wall ms |
|---|---|---:|---|---:|---:|---:|---:|---:|

## Incoming updates and connected idle

Update CPU is the CDP main-thread TaskDuration delta with Performance.enable(timeDomain=threadTicks), measured after one injected update through a 200 ms minimum window and two animation frames. Actual windows can be longer under load; their medians appear below and each duration remains raw. Heartbeats change lastActiveAt; issue updates change title (both legacy issue and projection in OLD, projection in NEW); terminal output is a short text line per frame. These are payload-specific observations, not costs for arbitrary issue edits or output byte volumes. Quiet windows measure the same instrumentation with no injection. These are observed total CPU costs in a window containing one update, not exclusive causal CPU per update; pending UI tasks, paints and real upstream traffic can overlap. The 60 s connected-idle replay delivers 30 heartbeat changes/minute, 10 issue changes/minute, and 120 terminal output frames/minute (two frames/second). These busy-profile rates are explicit synthetic assumptions, distinct from the historical-rate replay below. This is an idle UI with live data, not a silent disconnected app. Delivery to the visible terminal is verified before replay. Percent CPU means one renderer thread’s fraction of one core, not whole-machine or Mac desktop CPU.

| Arm | Surface | Scale | Update | n | Task CPU ms/window median | p95 |
|---|---|---:|---|---:|---:|---:|
| new | phone | 1 | heartbeat | 20 | 46.6 | 58.6 |
| new | phone | 1 | issue-change | 20 | 37.1 | 41.6 |
| new | phone | 1 | quiet | 16 | 3.1 | 8.3 |
| new | phone | 1 | session-output | 20 | 12.6 | 16.4 |
| new | phone | 4 | heartbeat | 10 | 172.7 | 220.5 |
| new | phone | 4 | issue-change | 10 | 169.0 | 185.2 |
| new | phone | 4 | quiet | 8 | 2.9 | 6.0 |
| new | phone | 4 | session-output | 10 | 12.0 | 17.0 |
| new | web | 4 | heartbeat | 10 | 596.3 | 689.4 |
| new | web | 4 | issue-change | 10 | 276.2 | 296.0 |
| new | web | 4 | quiet | 8 | 29.4 | 97.7 |
| new | web | 4 | session-output | 10 | 59.5 | 104.2 |
| new-current | web | 1 | heartbeat | 10 | 51.9 | 69.8 |
| new-current | web | 1 | issue-change | 10 | 28.8 | 85.7 |
| new-current | web | 1 | quiet | 8 | 16.9 | 23.0 |
| new-current | web | 1 | session-output | 10 | 24.0 | 36.7 |
| old → new | web | 4 | heartbeat | 10 | 1,300.2 | 1,382.7 |
| old → new | web | 4 | issue-change | 10 | 1,456.3 | 1,594.7 |
| old → new | web | 4 | quiet | 8 | 1,188.7 | 2,508.1 |
| old → new | web | 4 | session-output | 10 | 39.6 | 370.1 |
| old → new-current | web | 1 | heartbeat | 10 | 198.3 | 215.2 |
| old → new-current | web | 1 | issue-change | 10 | 197.5 | 219.8 |
| old → new-current | web | 1 | quiet | 8 | 8.5 | 17.9 |
| old → new-current | web | 1 | session-output | 10 | 24.2 | 37.2 |

Matched update-window comparisons, without subtracting quiet-window CPU:

| Surface | Scale | NEW arm | Update | n OLD/NEW | OLD CPU median ms | NEW CPU median ms | Change | OLD p95 | NEW p95 | OLD window ms | NEW window ms |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| web | 1 | new-current | quiet | 8/8 | 8.5 | 16.9 | 99.0% | 17.9 | 23.0 | 233.2 | 223.3 |
| web | 1 | new-current | heartbeat | 10/10 | 198.3 | 51.9 | -73.8% | 215.2 | 69.8 | 289.9 | 226.9 |
| web | 1 | new-current | session-output | 10/10 | 24.2 | 24.0 | -0.6% | 37.2 | 36.7 | 235.6 | 224.8 |
| web | 1 | new-current | issue-change | 10/10 | 197.5 | 28.8 | -85.4% | 219.8 | 85.7 | 257.8 | 231.6 |
| phone | 1 | new | quiet | 0/16 | — | 3.1 | — | — | 8.3 | — | 227.4 |
| phone | 1 | new | heartbeat | 0/20 | — | 46.6 | — | — | 58.6 | — | 225.3 |
| phone | 1 | new | session-output | 0/20 | — | 12.6 | — | — | 16.4 | — | 228.5 |
| phone | 1 | new | issue-change | 0/20 | — | 37.1 | — | — | 41.6 | — | 224.5 |
| phone | 4 | new | quiet | 0/8 | — | 2.9 | — | — | 6.0 | — | 221.5 |
| phone | 4 | new | heartbeat | 0/10 | — | 172.7 | — | — | 220.5 | — | 230.8 |
| phone | 4 | new | session-output | 0/10 | — | 12.0 | — | — | 17.0 | — | 223.9 |
| phone | 4 | new | issue-change | 0/10 | — | 169.0 | — | — | 185.2 | — | 241.6 |
| web | 4 | new | quiet | 8/8 | 1,188.7 | 29.4 | -97.5% | 2,508.1 | 97.7 | 1,226.2 | 227.4 |
| web | 4 | new | heartbeat | 10/10 | 1,300.2 | 596.3 | -54.1% | 1,382.7 | 689.4 | 1,323.1 | 643.2 |
| web | 4 | new | session-output | 10/10 | 39.6 | 59.5 | 50.3% | 370.1 | 104.2 | 232.7 | 230.7 |
| web | 4 | new | issue-change | 10/10 | 1,456.3 | 276.2 | -81.0% | 1,594.7 | 296.0 | 1,550.4 | 310.1 |

The **observed** profile approximates the [September 18 operator publication census](POD-4286-baseline-summary.json): 12 session, 6 issue, 16 machine, 28 conversation, 36 host-metric and 2 draft changes per minute. The minute clock advances normally. These are historical publication rates replayed with validated synthetic payloads, not a capture of historical network frames or today’s traffic. OLD issue/projection rows are sent together as one logical issue update. The **busy** profile adds the stated 30 heartbeat/10 issue/120 output cadence. Both windows use the same selected control terminal: web keeps the mission visible, while phone uses the standalone session terminal. Phone idle is not a Work-screen idle measurement.

| Arm | Surface | Scale | Profile | Seconds | Updates delivered | Main-thread task ms | One-core CPU % |
|---|---|---:|---|---:|---|---:|---:|
| new-current | web | 1 | observed | 60.0 | {"heartbeat": 12, "issueChange": 6, "machine": 16, "conversation": 28, "hostMetrics": 36, "draft": 2, "sessionOutput": 0} | 4,409.3 | 7.3 |
| new-current | web | 1 | busy | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 5,248.3 | 8.7 |
| new | phone | 1 | observed | 60.0 | {"heartbeat": 12, "issueChange": 6, "machine": 16, "conversation": 28, "hostMetrics": 36, "draft": 2, "sessionOutput": 0} | 1,502.3 | 2.5 |
| new | phone | 1 | busy | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 3,461.3 | 5.8 |
| new | phone | 1 | observed | 60.0 | {"heartbeat": 12, "issueChange": 6, "machine": 16, "conversation": 28, "hostMetrics": 36, "draft": 2, "sessionOutput": 0} | 1,395.3 | 2.3 |
| new | phone | 1 | busy | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 3,779.2 | 6.3 |
| new | phone | 4 | observed | 60.0 | {"heartbeat": 12, "issueChange": 6, "machine": 16, "conversation": 28, "hostMetrics": 36, "draft": 2, "sessionOutput": 0} | 4,500.2 | 7.5 |
| new | phone | 4 | busy | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 7,938.4 | 13.2 |
| new | web | 4 | observed | 60.0 | {"heartbeat": 12, "issueChange": 6, "machine": 16, "conversation": 28, "hostMetrics": 36, "draft": 2, "sessionOutput": 0} | 16,782.9 | 28.0 |
| new | web | 4 | busy | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 26,515.6 | 44.2 |
| old | web | 1 | observed | 60.0 | {"heartbeat": 12, "issueChange": 6, "machine": 16, "conversation": 28, "hostMetrics": 36, "draft": 2, "sessionOutput": 0} | 5,473.8 | 9.1 |
| old | web | 1 | busy | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 11,137.2 | 18.6 |
| old | web | 4 | observed | 60.0 | {"heartbeat": 12, "issueChange": 6, "machine": 16, "conversation": 28, "hostMetrics": 36, "draft": 2, "sessionOutput": 0} | 28,310.2 | 47.2 |
| old | web | 4 | busy | 60.0 | {"heartbeat": 30, "issueChange": 10, "sessionOutput": 120} | 54,803.7 | 91.3 |

Median of the separate 60-second windows:

| Surface | Scale | NEW arm | Profile | n OLD/NEW | OLD one-core CPU % | NEW one-core CPU % | Change |
|---|---:|---|---|---|---:|---:|---:|
| web | 1 | new-current | observed | 1/1 | 9.1 | 7.3 | -19.4% |
| web | 1 | new-current | busy | 1/1 | 18.6 | 8.7 | -52.9% |
| phone | 1 | new | observed | 0/2 | — | 2.4 | — |
| phone | 1 | new | busy | 0/2 | — | 6.0 | — |
| phone | 4 | new | observed | 0/1 | — | 7.5 | — |
| phone | 4 | new | busy | 0/1 | — | 13.2 | — |
| web | 4 | new | observed | 1/1 | 47.2 | 28.0 | -40.7% |
| web | 4 | new | busy | 1/1 | 91.3 | 44.2 | -51.6% |

## Retained JavaScript heap

Post-GC Runtime.getHeapUsage usedSize. One startup/5-minute pair per arm/surface/scale is an observation, not leak evidence. Memory runs use meter:flatblock and do not contribute timings.

| Arm | Surface | Scale | Startup MiB | Five minutes MiB | Duration s | Action groups |
|---|---|---:|---:|---:|---:|---:|

| Surface | Scale | NEW arm | OLD startup MiB | NEW startup MiB | Change | OLD five-minute MiB | NEW five-minute MiB | Change |
|---|---:|---|---:|---:|---:|---:|---:|---:|

## Action gaps and defects

OLD phone fails during startup at both 1x and 4x with React error 185, before a usable Work screen. The control-only fixture with two issues can boot, so this is a failure of OLD with this shared corpus, not evidence that every historical phone installation failed. The recorded failure is POD-5505. [React error 185](https://react.dev/errors/185) identifies excessive nested updates.

Consequently OLD has **no phone latency, action CPU, incoming-update CPU, connected-idle CPU, startup heap or five-minute heap comparison** at either requested scale. The unavailable OLD phone actions are cold start, warm start, Work, Tasks/issue screen, mission open, mission details, issue open, parent-picker search, Work search, rename, composer typing and long-press. NEW phone numbers are standalone measurements, never relative wins.

Inbox has no production route/tab in the measured revisions. Its detached component is excluded. The desktop session Chat composer is not available in the isolated agent fixture, despite advertising transcript capability; its typing latency is unavailable in both arms. The desktop global Superagent composer and phone mission composer are measured. This leaves session Chat typing and Inbox performance unresolved.

- NEW phone 1x: **phone-inbox** — Error: No Inbox tab or production route in this revision; detached Inbox component is not a whole-app measurement
- NEW phone 4x: **phone-inbox** — Error: No Inbox tab or production route in this revision; detached Inbox component is not a whole-app measurement
- NEW web 1x: **large-mission-switch** — TimeoutError: waitForFunction: Timeout 20000ms exceeded.
- NEW web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- NEW web 4x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- NEW-CURRENT web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- OLD web 1x: **large-mission-switch** — TimeoutError: waitForFunction: Timeout 20000ms exceeded.
- OLD web 1x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- OLD web 4x: **large-mission-switch** — TimeoutError: scrollIntoViewIfNeeded: Timeout 10000ms exceeded.
- OLD web 4x: **session-composer-typing** — TimeoutError: click: Timeout 10000ms exceeded.
- OLD web 4x: **sidebar-select** — TimeoutError: click: Timeout 10000ms exceeded.

Individual failed attempts, diagnostics, exclusions and exact errors remain in the run ledger and raw files. Long-press includes the product’s 500 ms gesture threshold. Rename starts at submit, after title entry; drag drop starts at pointer release, with drag initiation reported separately. Search starts with the input event that replaces the query and ends only after matching results replace the previous results. Sidebar selection includes issue switching; small mission switching additionally waits for the target mission’s session deck. Mutation and session actions use two small real control missions. The separate large-mission action selects the two largest corpus root trees by assigned descendant sessions; target IDs and actual rendered issue/session counts are recorded. Project folding targets a populated group from the largest root’s corpus repository, not an empty discovered repository.

The first current OLD and NEW 1x large-mission attempts loaded the same incorrect collector witness: the mission root is a header, while the tested row attribute belongs to its children. Those attempts have no large-mission latency and remain collector failures, not application defects. Corrected second rounds supply eight samples for each arm in that cell. Other actions from the first runs remain valid.

The first 1x background windows are excluded from background comparisons because OLD issue updates omitted the legacy issue row and the action workflow could leave different resident panes. Four dedicated background-only captures repeat OLD/NEW/OLD/NEW with complete logical issue updates and fresh matched UI contexts. All later background windows use that corrected recipe. Original observations remain raw; these are collector corrections, not product changes.

The first OLD 4x run also lost sidebar-selection samples when its unmeasured preparation exceeded the initial 10-second allowance. Its first large-root selector chose i4089, whose deferUntil is in November; the Work sidebar correctly hides that mission. Later collectors allow 60 seconds for preparation and choose the two largest roots that are not deferred or tucked. The project-fold corpus repository stays unchanged. The table reports available counts for those two cells. These missing attempts do not enter latency statistics.

The first OLD 4x run finished its action phase but failed background preparation because readiness expected the original title after optimistic rename. Its 220 completed action observations remain valid; its failed background preparation contributes no CPU windows. The contemporary NEW background window is excluded with it. A separate OLD/NEW background pair replaces that first 4x pair, alongside the normal second pair. Later readiness uses the stable issue ID and resets the title after the complete action phase.


Rendered DOM counts describe the work selected by each revision; they are not viewport-visible counts. The group anchor is chosen from the largest root’s corpus repository. Small differences in row counts and display labels are part of this release comparison, not a claim of identical DOM work.

| Arm | Scale | Round | Group anchor | Group rows | Group label | Large root | Large issue rows | Large session rows |
|---|---:|---:|---|---:|---|---|---:|---:|
| new-current | 1 | 30 | i1543 | 117 | 117 | i1766 | 306 | 176 |
| new-current | 1 | 30 | i1543 | 117 | 117 | i938 | 186 | 106 |
| new | 1 | 10 | i1543 | 117 | 117 | — | — | — |
| new | 1 | 11 | i1543 | 117 | 117 | i1766 | 306 | 176 |
| new | 1 | 11 | i1543 | 117 | 117 | i938 | 186 | 106 |
| new | 4 | 10 | i4892 | 156 | 156 | i13916 | 324 | 172 |
| new | 4 | 10 | i4892 | 156 | 156 | i8355 | 242 | 131 |
| new | 4 | 11 | i4892 | 156 | 156 | i13916 | 324 | 172 |
| new | 4 | 11 | i4892 | 156 | 156 | i8355 | 242 | 131 |
| old | 1 | 10 | i1543 | 112 | repo-000112 | — | — | — |
| old | 1 | 11 | i1543 | 112 | repo-000112 | i1766 | 306 | 176 |
| old | 1 | 11 | i1543 | 112 | repo-000112 | i938 | 186 | 106 |
| old | 1 | 30 | i1543 | 112 | repo-000112 | i1766 | 306 | 176 |
| old | 1 | 30 | i1543 | 112 | repo-000112 | i938 | 186 | 106 |
| old | 4 | 10 | i4892 | 151 | repo-004151 | — | — | — |
| old | 4 | 11 | i4892 | 151 | repo-004151 | i13916 | 324 | 172 |
| old | 4 | 11 | i4892 | 151 | repo-004151 | i8355 | 242 | 131 |

## Run order, provenance, host load

Runs execute sequentially on flatblock, one implementation per process. Leases are taken on ludovico after server/browser preparation, released as soon as capture ends. A fresh browser context means cold data start; reload of that profile means warm-data start. Bootstrap routing disables HTTP cache in both arms. Pixel 7 Chromium emulation is phone web evidence, not physical Android/native performance. No CPU or network throttle is applied. No product source is changed. No full test suite runs.

| Started UTC | Mode | Arm | Surface | Scale | Round | Status | Purpose / exclusions | Load start (1/5/15m) | Load end | Browser |
|---|---|---|---|---:|---:|---|---|---|---|---|
| 2026-10-04T12:08:54.644Z | probe | old | web | 1 | 0 | complete | legacy diagnostic | 3.6, 3.7, 4.4 | 4.1, 3.8, 4.4 | 153.0.8010.12 |
| 2026-10-04T12:10:59.980Z | probe | old | phone | 1 | 0 | failed | legacy diagnostic | 3.2, 3.6, 4.3 | 3.2, 3.6, 4.3 | 153.0.8010.12 |
| 2026-10-04T12:13:00.737Z | probe | old | web | 1 | 1 | failed | legacy diagnostic | 3.4, 3.4, 4.1 | 3.4, 3.4, 4.1 | — |
| 2026-10-04T12:15:47.266Z | probe | old | web | 1 | 2 | complete | legacy diagnostic | 2.6, 3.2, 3.9 | 6.2, 4.1, 4.2 | 153.0.8010.12 |
| 2026-10-04T12:18:08.774Z | probe | new | web | 1 | 1 | complete | legacy diagnostic | 4.3, 3.9, 4.1 | 5.0, 4.1, 4.2 | 153.0.8010.12 |
| 2026-10-04T12:18:34.229Z | probe | old | phone | 1 | 1 | failed | legacy diagnostic | 4.6, 4.0, 4.2 | 3.4, 3.8, 4.0 | 153.0.8010.12 |
| 2026-10-04T12:29:31.281Z | probe | new | phone | 1 | 1 | failed | legacy diagnostic | 2.9, 3.5, 3.9 | 3.9, 3.6, 3.9 | 153.0.8010.12 |
| 2026-10-04T12:32:48.721Z | probe | old | phone | 1 | 2 | failed | legacy diagnostic | 3.9, 3.7, 3.9 | 3.2, 3.5, 3.7 | 153.0.8010.12 |
| 2026-10-04T12:38:21.026Z | probe | new | phone | 1 | 2 | failed | legacy diagnostic | 3.3, 3.6, 3.8 | 3.5, 3.7, 3.8 | 153.0.8010.12 |
| 2026-10-04T12:39:55.418Z | timing | old | web | 1 | 100 | failed | selector-calibration | 4.9, 4.0, 3.9 | 5.6, 4.1, 3.9 | 153.0.8010.12 |
| 2026-10-04T12:40:24.422Z | timing | new | web | 1 | 100 | failed | selector-calibration | 6.6, 4.5, 4.0 | 8.0, 4.8, 4.2 | 153.0.8010.12 |
| 2026-10-04T12:41:33.947Z | timing | old | web | 1 | 101 | failed | selector-calibration | 6.2, 4.9, 4.2 | 10.2, 7.7, 5.4 | 153.0.8010.12 |
| 2026-10-04T12:44:32.716Z | timing | new | web | 1 | 101 | failed | selector-calibration | 8.9, 7.5, 5.4 | 8.4, 8.0, 6.0 | 153.0.8010.12 |
| 2026-10-04T12:47:58.265Z | timing | old | web | 1 | 102 | complete | selector-calibration | 6.3, 7.5, 5.9 | 7.5, 8.7, 6.8 | 153.0.8010.12 |
| 2026-10-04T12:52:20.820Z | timing | new | web | 1 | 102 | complete | selector-calibration | 6.9, 8.5, 6.8 | 5.7, 7.2, 6.7 | 153.0.8010.12 |
| 2026-10-04T12:57:29.323Z | timing | old | web | 1 | 103 | complete | selector-calibration | 8.2, 7.4, 6.8 | 8.0, 9.0, 7.7 | 153.0.8010.12 |
| 2026-10-04T13:01:19.560Z | timing | new | web | 1 | 103 | failed | selector-calibration | 6.4, 8.6, 7.5 | 6.4, 8.6, 7.5 | — |
| 2026-10-04T13:06:51.752Z | timing | new | phone | 1 | 104 | complete | selector-calibration | 2.0, 4.2, 5.9 | 8.9, 6.7, 6.6 | 153.0.8010.12 |
| 2026-10-04T13:12:35.149Z | probe | old | phone | 1 | 3 | complete | superseded | 5.3, 6.3, 6.4 | 5.1, 6.2, 6.4 | 153.0.8010.12 |
| 2026-10-04T13:16:17.522Z | timing | old | phone | 1 | 0 | failed | superseded | 2.5, 4.4, 5.6 | 2.5, 4.4, 5.6 | 153.0.8010.12 |
| 2026-10-04T13:16:35.620Z | timing | new | phone | 1 | 0 | complete | selector-calibration | 2.5, 4.3, 5.6 | 6.2, 5.3, 5.7 | 153.0.8010.12 |
| 2026-10-04T13:21:26.747Z | timing | old | phone | 1 | 1 | failed | superseded | 5.7, 5.3, 5.7 | 5.7, 5.3, 5.7 | 153.0.8010.12 |
| 2026-10-04T13:21:46.429Z | timing | new | phone | 1 | 1 | complete | selector-calibration | 5.8, 5.3, 5.7 | 3.0, 5.0, 5.5 | 153.0.8010.12 |
| 2026-10-04T13:26:40.742Z | timing | old | phone | 4 | 0 | failed | superseded | 4.3, 5.2, 5.5 | 4.3, 5.2, 5.5 | 153.0.8010.12 |
| 2026-10-04T13:27:03.225Z | timing | new | phone | 4 | 0 | complete | superseded | 4.1, 5.0, 5.5 | 4.1, 5.3, 5.6 | 153.0.8010.12 |
| 2026-10-04T13:34:11.450Z | timing | old | phone | 4 | 1 | failed | superseded | 3.8, 5.2, 5.5 | 3.7, 5.1, 5.5 | 153.0.8010.12 |
| 2026-10-04T13:34:33.685Z | timing | new | phone | 4 | 1 | complete | superseded | 4.4, 5.2, 5.5 | 2.7, 4.7, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:43:07.503Z | timing | old | phone | 1 | 2 | failed | superseded | 3.3, 4.2, 5.1 | 3.7, 4.2, 5.1 | 153.0.8010.12 |
| 2026-10-04T13:43:29.007Z | timing | new | phone | 1 | 2 | complete | superseded | 4.2, 4.3, 5.1 | 3.8, 5.0, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:48:05.984Z | timing | old | phone | 1 | 3 | failed | superseded | 4.4, 5.1, 5.3 | 4.4, 5.1, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:48:25.801Z | timing | new | phone | 1 | 3 | complete | superseded | 4.3, 5.0, 5.3 | 3.2, 5.0, 5.3 | 153.0.8010.12 |
| 2026-10-04T13:54:19.021Z | timing | old | web | 1 | 0 | complete | superseded | 2.6, 4.2, 5.0 | 5.6, 5.2, 5.2 | 153.0.8010.12 |
| 2026-10-04T13:59:37.997Z | timing | new | web | 1 | 0 | complete | superseded | 5.5, 5.2, 5.2 | 5.9, 5.1, 5.1 | 153.0.8010.12 |
| 2026-10-04T14:04:45.956Z | timing | old | web | 1 | 1 | complete | superseded | 5.8, 5.1, 5.1 | 4.2, 4.4, 4.8 | 153.0.8010.12 |
| 2026-10-04T14:10:10.515Z | timing | new | web | 1 | 1 | complete | superseded | 4.9, 4.6, 4.8 | 5.9, 5.7, 5.3 | 153.0.8010.12 |
| 2026-10-04T14:15:26.009Z | timing | old | web | 4 | 0 | complete | superseded | 5.4, 5.6, 5.2 | 4.2, 4.4, 4.9 | 153.0.8010.12 |
| 2026-10-04T15:04:25.785Z | timing | old | web | 1 | 10 | complete | measurement; background excluded | 7.8, 6.0, 5.6 | 4.8, 5.7, 5.7 | 153.0.8010.12 |
| 2026-10-04T15:14:05.664Z | timing | new | web | 1 | 10 | complete | measurement; background excluded | 2.0, 4.2, 5.1 | 5.7, 4.5, 4.9 | 153.0.8010.12 |
| 2026-10-04T15:22:55.872Z | timing | old | web | 1 | 11 | complete | measurement; background excluded | 3.4, 4.3, 4.8 | 3.7, 5.9, 5.7 | 153.0.8010.12 |
| 2026-10-04T15:30:33.368Z | timing | new | web | 1 | 11 | complete | measurement; background excluded | 3.3, 5.7, 5.6 | 8.8, 6.5, 6.0 | 153.0.8010.12 |
| 2026-10-04T15:37:43.180Z | timing | old | web | 4 | 10 | failed | measurement; background excluded; action phase retained | 10.4, 7.1, 6.2 | 5.7, 7.3, 7.1 | 153.0.8010.12 |
| 2026-10-04T16:00:04.401Z | timing | new | web | 4 | 10 | complete | measurement; background excluded | 11.1, 8.7, 7.7 | 12.8, 9.0, 8.0 | 153.0.8010.12 |
| 2026-10-04T16:16:04.521Z | timing | old | web | 4 | 11 | complete | measurement | 15.0, 10.6, 8.6 | 13.8, 11.6, 10.7 | 153.0.8010.12 |
| 2026-10-04T16:47:13.246Z | timing | new | web | 4 | 11 | complete | measurement | 5.7, 9.5, 10.4 | 6.1, 8.8, 10.3 | 153.0.8010.12 |
| 2026-10-04T17:02:40.799Z | timing | old | phone | 1 | 10 | failed | preparation-failure | 6.1, 8.8, 10.3 |  | — |
| 2026-10-04T17:04:35.499Z | timing | new | phone | 1 | 10 | failed | preparation-failure | 9.2, 9.3, 10.3 | 9.2, 9.3, 10.3 | — |
| 2026-10-04T17:08:34.939Z | timing | old | phone | 1 | 14 | failed | measurement | 4.3, 7.1, 9.2 | 4.3, 7.1, 9.2 | 153.0.8010.12 |
| 2026-10-04T17:08:55.779Z | timing | new | phone | 1 | 14 | complete | measurement | 5.1, 7.1, 9.2 | 10.6, 8.8, 9.3 | 153.0.8010.12 |
| 2026-10-04T17:15:08.668Z | timing | old | phone | 1 | 15 | failed | measurement | 10.0, 8.8, 9.2 | 10.0, 8.8, 9.2 | 153.0.8010.12 |
| 2026-10-04T17:24:45.643Z | timing | new | phone | 1 | 15 | complete | measurement | 8.4, 10.8, 10.8 | 13.0, 12.6, 11.6 | 153.0.8010.12 |
| 2026-10-04T17:31:22.136Z | timing | old | phone | 4 | 14 | failed | measurement | 12.4, 12.4, 11.5 | 13.2, 12.6, 11.6 | 153.0.8010.12 |
| 2026-10-04T17:31:47.154Z | timing | new | phone | 4 | 14 | complete | measurement | 14.5, 12.9, 11.7 | 3.2, 6.5, 9.4 | 153.0.8010.12 |
| 2026-10-04T17:41:52.001Z | timing | old | phone | 4 | 15 | failed | superseded | 3.9, 6.5, 9.3 | 4.4, 6.5, 9.3 | 153.0.8010.12 |
| 2026-10-04T17:42:16.041Z | timing | new | phone | 4 | 15 | failed | superseded | 4.1, 6.3, 9.2 | 21.2, 12.2, 10.8 | 153.0.8010.12 |
| 2026-10-04T17:56:05.651Z | timing | old | phone | 4 | 16 | failed | collector-failure | 14.7, 14.7, 12.5 | 14.7, 14.7, 12.5 | 153.0.8010.12 |
| 2026-10-04T18:02:27.194Z | timing | old | phone | 4 | 17 | failed | superseded | 6.7, 8.7, 10.4 | 7.1, 8.8, 10.4 | 153.0.8010.12 |
| 2026-10-04T18:02:52.642Z | timing | new | phone | 4 | 17 | failed | superseded | 7.4, 8.7, 10.3 | 3.7, 7.4, 9.3 | 153.0.8010.12 |
| 2026-10-04T18:27:26.226Z | timing | old | web | 1 | 30 | complete | measurement | 5.3, 8.8, 8.4 | 11.6, 11.8, 9.8 | 153.0.8010.12 |
| 2026-10-04T18:35:20.541Z | timing | new-current | web | 1 | 30 | complete | measurement | 10.7, 11.5, 9.8 | 4.8, 7.6, 8.7 | 153.0.8010.12 |

Host CPU utilization below is the /proc/stat delta across capture, all logical cores; it includes other processes. It is separate from measured renderer CPU.

| Arm | Surface | Scale | Round | CPU model | Logical cores | Host CPU busy % | Harness digest |
|---|---|---:|---:|---|---:|---:|---|
| new-current | web | 1 | 30 | AMD EPYC Processor (with IBPB) | 8 | 54.5 | ae1b27a87439e436 |
| new | phone | 1 | 14 | AMD EPYC Processor (with IBPB) | 8 | 66.6 | eab4434cbf3b465d |
| new | phone | 1 | 15 | AMD EPYC Processor (with IBPB) | 8 | 74.1 | eab4434cbf3b465d |
| new | phone | 4 | 14 | AMD EPYC Processor (with IBPB) | 8 | 58.0 | eab4434cbf3b465d |
| new | web | 1 | 10 | AMD EPYC Processor (with IBPB) | 8 | 40.0 | 4b4ad7b2ad639fd5 |
| new | web | 1 | 11 | AMD EPYC Processor (with IBPB) | 8 | 49.7 | 5a00f752eca2f258 |
| new | web | 4 | 10 | AMD EPYC Processor (with IBPB) | 8 | 55.3 | 2220f5ddbd4f6b5b |
| new | web | 4 | 11 | AMD EPYC Processor (with IBPB) | 8 | 67.5 | 2220f5ddbd4f6b5b |
| old | phone | 1 | 14 | AMD EPYC Processor (with IBPB) | 8 | 52.4 | eab4434cbf3b465d |
| old | phone | 1 | 15 | AMD EPYC Processor (with IBPB) | 8 | 68.1 | eab4434cbf3b465d |
| old | phone | 4 | 14 | AMD EPYC Processor (with IBPB) | 8 | 93.4 | eab4434cbf3b465d |
| old | web | 1 | 10 | AMD EPYC Processor (with IBPB) | 8 | 49.9 | 4b4ad7b2ad639fd5 |
| old | web | 1 | 11 | AMD EPYC Processor (with IBPB) | 8 | 49.0 | 5a00f752eca2f258 |
| old | web | 1 | 30 | AMD EPYC Processor (with IBPB) | 8 | 72.5 | ae1b27a87439e436 |
| old | web | 4 | 10 | AMD EPYC Processor (with IBPB) | 8 | 55.8 | e0d8a84eb2258bd1 |
| old | web | 4 | 11 | AMD EPYC Processor (with IBPB) | 8 | 64.0 | 2220f5ddbd4f6b5b |

## Evidence and reproduction

Run and per-sample timestamps, SHAs, semantic/product digests, exact bootstrap counts, captured process IDs, lease grant, load, CPU deltas and failures are in the [raw run files](POD-4286-old-vs-new/raw/) and [machine-readable comparisons](POD-4286-old-vs-new/results.json). Compressed Chromium traces and sampled profiles are preserved in the isolated flatblock checkouts; their issue-attachment manifest is published with the final report.

Preparation uses each arm’s own .toolchain/bun and checkout-local dependencies: bun run setup:worktree, then bun scripts/browser-lane.ts --build-only. old-vs-new-corpus.mjs serializes the OLD seed once and adapts that same JSON to NEW’s schema; old-vs-new.mjs validates the augmented stream through the production decoder before capture. Run old-vs-new-remote.py from ludovico with --arm, --surface, --scale, --mode and --round; it runs one foreground SSH process, acquires bench:flatblock for timing or meter:flatblock for heap/diagnostic captures, delivers the lease grant to the arm, and releases at CAPTURE_FINISHED. Timing rounds alternate OLD/NEW. All browser contexts and the recorded server PID are torn down before the next arm. Four cold/warm pairs per round are unprofiled; one additional pair and the last two repetitions of each action are profiled separately. Cold means fresh app storage against an already-running isolated server; warm means reload with retained durable rows and preferences. HTTP cache is disabled by the bootstrap route in both arms, so these are warm-data reloads, not measurements of production HTTP-cache savings. [Playwright routing documentation](https://playwright.dev/docs/api/class-browsercontext#browser-context-route). Neither measures desktop sidecar spawn, a physical phone, network conditions or real agent startup. No test suite or product-code edits are part of these captures.

Startup ends at the first qualifying Paint after an unobscured task row appears inside the viewport and the boot splash is absent. It measures first task content, not completion of every asynchronous child or agent startup. The final action context additionally proves the complete requested corpus reached durable client storage. Warm reload retains storage and preferences, with HTTP cache disabled by routing, and still receives the same augmented bootstrap replay; it does not model a production cursor-resume optimization. The baseline NEW 4x phone round 15 lost the early navigation trace mark during its separately profiled fifth cold start. That run and its matched OLD attempt are excluded. The round-17 replacement hit shared-host ENOSPC and is also excluded; the coordinator then prioritized CURRENT web before further baseline phone repeats; eight completed unprofiled startup values remain raw. A failed neutral health-response preparation in round 16 never navigated to the app. Later collectors prime the renderer with routed blank HTML at the same origin before tracing; no app assets or data are loaded by that step. The qualifying paint definition stays unchanged. Preparation waits may be longer than measured paint times: ordinary actionability permits 60 seconds after the first 4x OLD preparation exceeded the initial 10-second allowance, while semantic capture waits are 20 seconds after dispatch returns. Every failed attempt is retained.
