# Ten Seconds

Stop the clock at exactly **10:00:00**. A precision arcade game, built as an installable, offline-capable Progressive Web App with a global leaderboard.

```bash
npm start          # http://localhost:8080  (Node 20+, no dependencies)
npm test           # timing + API tests
npm run assets     # regenerate icons and iOS launch screens (needs Playwright; then quantize the PNGs to keep them small)
```

## Timer format: `SS:CC:XX`

| Section | Meaning |
| --- | --- |
| `SS` | whole seconds |
| `CC` | centiseconds (1/100 s) |
| `XX` | the next two decimals: the millisecond digit, then the 1/10 000 s digit |

`00:00:00` is zero, `05:00:00` is five seconds, `09:99:99` is 9.9999 s, `10:00:00` is exactly ten seconds.

- Time is measured with `performance.now()`. Start and stop use the input event's own `timeStamp` (same clock), so a busy main thread doesn't add latency.
- The display is **truncated**, never rounded up, so it can't show `10:00:00` before 10 000 ms have actually passed.
- **PERFECT** is decided from the raw elapsed milliseconds, never from the display string: `|elapsed − 10 000| < 0.5 ms`, which is 10 000 ms at millisecond precision. Browsers deliberately coarsen timers (Safari and Firefox use 1 ms steps), so a finer tolerance would be impossible to hit on those engines. One consequence: `09:99:96` (9 999.6 ms) is PERFECT, and `10:00:05` (10 000.5 ms) is not.
- The server re-computes the verdict from `elapsedMs`. Clients can't claim a perfect score.

Logic: `public/js/timing.js` (shared by the browser, the server and the tests).

## PWA

- `manifest.webmanifest`: `standalone` with a `fullscreen` override, theme and background `#07070d`, 10 "any" icons (48 to 512 px), maskable 192/512, monochrome, shortcuts (Play, Leaderboard), and narrow/wide screenshots for the richer install sheet.
- iOS: `apple-touch-icon`, `black-translucent` status bar, and 19 `apple-touch-startup-image` launch screens covering current iPhones and iPads.
- An in-app splash screen shows while fonts and state load.
- Install button: uses the native prompt (`beforeinstallprompt`) on Chromium, and Add to Home Screen instructions on iOS. It's hidden once the app is installed.
- Layout: safe-area insets (`viewport-fit=cover`), `100dvh`, no scrolling, no pinch zoom, no text selection or callouts. Large touch targets. Phone landscape puts the button beside the clock. Works on tablet and desktop.

## Offline

`public/sw.js` precaches the app shell (HTML, CSS, JS, fonts, icons). Navigations are served from the cache, so the app opens instantly with no network. `/api/*` is never cached.

The server stamps `sw.js` with a hash of the app files. Any deploy installs a fresh cache, and the app shows an **UPDATE** toast. It never swaps versions in the middle of a run.

### Results while offline

1. Every finished run is written to IndexedDB (`public/js/queue.js`) **before** any network call.
2. Then the app submits it. Only a 2xx response from the server marks it **Submitted ✓**.
3. If submission fails, the result card says *"OFFLINE · Saved on this device. NOT submitted yet…"*, the header pill turns amber (**OFFLINE**) with a pending count, and the leaderboard lists the unsent results.
4. Pending results are resent automatically:
   - when a `/api/health` check succeeds (every 5 s while offline, 30 s otherwise)
   - on the `online` event and when the app returns to the foreground
   - via Background Sync where supported, even if the app is closed

   The connection indicator relies on the real health check, because `navigator.onLine` is unreliable.
5. Each result has a client-generated `clientId`, and the server ignores duplicates. Retries from the page and from the service worker can't double-count.
6. If the server refuses a result as invalid (for example, older than 30 days), it is removed from the queue and the player is told. It never fails silently.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | reachability check |
| `GET` | `/api/leaderboard?limit=50&player=<id>` | each player's best result, ranked by distance from 10 000 ms |
| `POST` | `/api/results` | `{ clientId, playerId, name, elapsedMs, playedAt }`. Returns `201`, or `200` for a duplicate, or `422` for invalid data, or `429` when rate-limited |

Results are stored in `data/results.json` (`DATA_FILE` to override; `PORT` sets the port). For production scale, replace the `db` object in `server.js` with a real database; the API stays the same.

## Deploying

Service workers and installation require **HTTPS** (except on `localhost`). Run `node server.js` behind any HTTPS reverse proxy or host. The server sets `Cache-Control: no-cache` on `sw.js`, the HTML and the manifest, and a CSP plus standard security headers.

Fonts: Orbitron and Rajdhani, self-hosted under the SIL Open Font License (see `public/fonts/`).
