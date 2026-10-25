# Performance and range selection implementation plan

**Goal:** Smooth long playlist/song scrolling and dragging, keep idle work small, and support whole-row clicks with Shift range selection.

**Architecture:** Retain the online/local comparison and page boundaries, but render only the viewport plus a small overscan. Memoize stable data and rows, keep drag feedback outside React state, reuse unchanged polling snapshots and return HTTP 304 for unchanged server state. Reduce repeated SQL compilation and database exports while retaining durable song relationships and cancellation semantics.

**Tech Stack:** Electron, React, Express, sql.js, Node test runner, Playwright/CDP.

1. Capture a mock-only baseline with 600 playlists and 4867 songs using `scripts/profile-performance.cjs`; record renderer work and frame intervals for the same scroll/drag workload before and after.
2. Add a reusable viewport hook in `src/renderer/use-virtual-window.jsx`. Apply it to paginated song lists, unlinked song previews and the long online playlist table, retaining scroll extent and numbering. Keep local rows' variable heights intact.
3. Memoize editor filtering, counts, callbacks and row components; native drag hover should not re-render the entire editor. Whole-row clicks toggle a song and Shift extends the anchor's select/deselect state across the filtered ordering, including page boundaries. Each range is one undo step.
4. Add stable snapshot reconciliation and serial, visibility-aware conditional polling in renderer/API modules. Cache server bootstrap responses by database and task revision; verify 304 responses and invalidation on settings, task and scan changes.
5. Reuse prepared SQL for bulk song choices, group each newly downloaded song and relationship in one durable transaction, and avoid writing transient progress to disk on every song.
6. Remove full-screen backdrop blur and contain list painting; keep the existing software-rendering compatibility behavior. Check frame metrics before considering any rendering backend change.
7. Test virtual scroll reachability, selection and Shift deselection, range undo/redo, cross-page persistence, search, drag/drop, unchanged polling and durable sync. Run the required unit/integration and desktop suites, inspect screenshots, package, validate MP3 and the installed executable, then update the original desktop installation with a backup.

## Renderer measurements

The same synthetic account, 600 additional playlists, 4867-song comparison, 1440×880 window and software compositor were used before and after. `scripts/profile-performance.cjs` runs 90 animation-frame ticks per workload and uses Chromium's renderer metrics. The song workload starts when the dialog opens, so removal of its scale animation contributes to these results. These are measurements from this host, not a hardware-independent FPS guarantee.

| Measurement | Before | After |
| --- | ---: | ---: |
| Song scroll/drag script work | 203 ms | 47 ms |
| Song scroll/drag P95 frame interval | 92 ms | 8 ms |
| Song rows mounted at end of workload | 100 | 20 |
| Idle renderer script work over 4 seconds | 39 ms | 2 ms |
| Playlist rows mounted at end of workload | 602 | 12 |
| Playlist scroll P95 frame interval | 6 ms | 8 ms |

Playlist windowing trades additional JavaScript/layout work while jumping across the entire table (78 ms versus 20 ms of script work) for bounded DOM size; its measured frame interval remains short. Avoid describing this result as a reduction of playlist scrolling CPU work. Song interaction and unchanged background polling show the main measured improvements.
