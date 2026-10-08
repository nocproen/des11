# des11 deployment

## Source fidelity

Imported from https://github.com/nocproen/des11.git, commit
`0836d3a31fbc60f8fb6138f47acc61941bc116db`.

The original Chinese-language desktop, lock screen, administrator interface,
wallpapers, noVNC assets, applications and PostgreSQL schema are preserved.
Additional direct npm dependencies use the exact resolved versions in the source
lockfile. The platform's Next.js/PostgreSQL build/start commands are retained.
This is the original app plus the synchronization fixes below, not a byte-for-byte
unmodified checkout. Historical `.backup-*` files and the old deployment patch
script are not part of the active deployment.

## Setup

1. Install npm dependencies with `npm ci`.
2. Run `bash scripts/setup-runtime.sh` on Debian/Ubuntu. It provisions the original
   TigerVNC/Openbox/xterm/Chromium stack, CJK fonts, clipboard support, and the
   Playwright Chromium binary. It requires passwordless sudo for package setup.
3. Configure `DATABASE_URL`, `ADMIN_PASSWORD`, and `DESKTOP_PASSWORD` in `.env`
   (server-side only). Use strong independently generated passwords. Optional:
   `ADMIN_USER` (default `admin`) and `ADMIN_PATH` (default `ops-7k2m9x4q`).
   Never commit `.env`. The upstream fallback administrator password is not used
   by this configured deployment.
4. Bootstrap the platform environment, then run `npx drizzle-kit push` to apply
   `src/db/schema.ts` using the configured local PostgreSQL database.
5. Validate with `npx next typegen`, `npm exec tsc -- --noEmit --pretty false`, and
   `npm run build`. Start with the platform-managed production runtime.
6. Once the server is running, run `node scripts/setup-access.mjs`. It uses the
   original authenticated admin API and does not reset an existing desktop
   password. `PREVIEW_BASE_URL` defaults to `http://127.0.0.1:3000`.
7. Open `/` and enter `DESKTOP_PASSWORD`. Administration is at `/<ADMIN_PATH>`.

## Synchronization changes

- Desktop updates use a PostgreSQL transaction/advisory lock and a three-way
  per-window, per-field merge. Independent concurrent edits are retained, closed
  windows are not resurrected by stale clients, and acknowledged writes are
  persisted immediately.
- Authenticated SSE sends window and file/settings changes to every connected
  browser. Polling, visibility/focus and online handlers recover missed events
  and temporarily disconnected clients. Pending local layout edits are retried.
- The same terminal window uses one PTY across browsers. Concurrent attachment is
  locked, refresh detaches only the viewer, recent output is replayed, and the
  upstream two-minute no-viewer grace period is retained. `open` and `gui`
  commands are delivered once to the input-originating browser, then the created
  window is shared. Transient database errors do not terminate shells. Terminal
  component loading waits for connectivity, avoiding failed lazy imports when a
  terminal window is first opened offline.
- Existing native GUI/noVNC and remote-browser sessions remain shared by window
  ID; their session-creation race after expiry is fixed. Session shutdown belongs
  to the server-confirmed shared window-close action, not an individual viewer's
  component cleanup, so refreshing one browser never kills a peer's session.
- The two-browser integration suite passed both locally and through the public
  HTTPS preview proxy, covering offline/reconnect behavior, concurrent changes,
  files/settings, terminal input/output, native GUI sessions and browser tabs.
- Cloud files and settings refresh through SSE plus a two-second polling fallback.
  Both cloud and native text editors load external saved changes while preserving
  unsaved drafts. Stale saves return HTTP 409 and provide a reload action.
- Native filesystem operations and the real terminal use the same Linux home
  directory. Native directory views poll every 3–4 seconds; text editors poll
  every two seconds, so direct shell/tool changes are visible without reloading.
  The original database-backed cloud drive/sandbox terminal remain a separate
  filesystem, as in the source application.

## Scope and safety

This is a single trusted shared desktop, not isolated per-user workspaces. The
terminal and native GUI applications execute on the server with its OS user's
permissions. Keep authentication enabled and deploy only in an isolated sandbox
for trusted users. Serve through HTTPS with WebSocket and SSE forwarding.
PostgreSQL stores cloud files, settings, credentials and window layouts; native
files and browser profiles require persistent home storage. PTY/GUI processes are
in-memory OS sessions: they survive client reconnects, not server restarts.
Use a single application runtime for shared native sessions; horizontal scaling
would require a separate session broker or sticky session routing.

GUI text saves serialize read/compare/write within the runtime. Direct terminal
programs are not collaborative text editors; arbitrary simultaneous shell writes
still follow normal filesystem last-writer semantics. Unsaved text is deliberately
local until saved. This is synchronization, not character-level CRDT editing.

## Verification

`node scripts/test-sync.mjs` runs integration checks using the configured desktop
password, two independent Playwright browser contexts, authenticated APIs, and
real terminal WebSockets. The test restores the original layout/settings and
removes its fixture files. Production checks also include `/api/health`.

The imported dependency versions are intentionally retained for source fidelity.
An npm security audit reports upstream vulnerabilities; review/update the pinned
versions before any deployment beyond an isolated, access-controlled preview.
