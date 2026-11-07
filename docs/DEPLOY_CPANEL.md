# Deploying Boat Race Tracker on cPanel

About 10 minutes. You need your cPanel login and the file **`boat-race-tracker-cpanel.zip`**:
download it from the **Test build** release on GitHub
(`https://github.com/dodol183/boat-race-tracker/releases/tag/test-build`). Nothing needs installing:
the zip holds the whole server, and Node 22 brings the database with it.

In these steps, `race.yourdomain` stands for the address you choose (for example a subdomain next
to your current site), and `<you>` for your cPanel user name.

## 1. An address with HTTPS

1. cPanel → **Domains** → **Create A New Domain**. Enter `race.yourdomain`. Leave the document root
   cPanel suggests. Submit.
2. cPanel → **SSL/TLS Status** → tick `race.yourdomain` → **Run AutoSSL**. Wait until it shows a
   valid certificate (a few minutes). The Android app and Bluetooth need HTTPS.

## 2. Upload the files (outside public_html)

The app and its data live outside `public_html`, so the web server can never hand them out as files.

1. cPanel → **File Manager** → your home folder (`/home/<you>`).
2. **+ Folder**: `boat-race-tracker`. Another: `brt-data`.
3. Open `boat-race-tracker` → **Upload** → `boat-race-tracker-cpanel.zip`.
4. Back in the folder, right-click the zip → **Extract** → into `/home/<you>/boat-race-tracker`.
   You should see `app.js`, `server.mjs`, `public/`, `package.json`, `DEPLOY.md`. Delete the zip.

## 3. Create the Node.js app

cPanel → **Setup Node.js App** → **Create Application**:

| Field | Value |
|---|---|
| Node.js version | **22.x**, at least 22.13 (the newest 22 in the list) |
| Application mode | Production |
| Application root | `boat-race-tracker` |
| Application URL | `race.yourdomain` |
| Application startup file | `app.js` |

Under **Environment variables**, add:

| Name | Value |
|---|---|
| `ADMIN_TOKEN` | a long random password, 24 characters or more (from a password manager). You type it to create regattas. |
| `DATA_DIR` | `/home/<you>/brt-data` |

**Create**, then **Restart**. There is no "Run NPM Install" step: the app has no packages to install.
If cPanel offers it anyway, it does nothing harmful.

## 4. Check it

1. Open `https://race.yourdomain/api/health`. It should say
   `{"ok":true, ..., "version":"…", "node":"v22.…", "seenAs":"…"}`.
   - `seenAs` should be your own public address (compare with any "what is my IP" site, on the
     same connection). If it shows `127.0.0.1` or `?`, the host isn't passing on visitors'
     addresses: the wrong-PIN limit would then count everyone together. Ask Exabytes to pass the
     `X-Forwarded-For` header to the Node.js app.
   - A page titled **"Boat Race Tracker isn't running yet"** lists what to fix (Node version,
     `ADMIN_TOKEN`, data folder). Fix it in Setup Node.js App and press **Restart**.
2. Open `https://race.yourdomain`. Tap **Run a new regatta**, give it a name, enter your
   `ADMIN_TOKEN`, **Create**. Write down the event code and both PINs, then **Open as the race office**.
3. The header should show a green **Live**. If it stays on **Connecting…**, see "Connecting…
   forever" below.

## 5. Point the Android app at it

Either type `race.yourdomain` in the app's **Server** field on its join screen, or build it in: on
GitHub, **Settings → Secrets and variables → Actions → Variables → New repository variable**,
name `BRT_SERVER_URL`, value `https://race.yourdomain`. The next test build has it.

## Updating

Download the newest `boat-race-tracker-cpanel.zip`, upload it to `/home/<you>/boat-race-tracker`
and extract it over the old files. Your regattas are in `brt-data`, which the zip never touches. The
zip carries `tmp/restart.txt`, which restarts the app; if the version in `/api/health` hasn't
changed, press **Restart** in Setup Node.js App.

## Backups

The server copies its database once a day into `/home/<you>/brt-data/backups`, one file per weekday
(`regattas-Mon.db` … `regattas-Sun.db`), so the last seven days are always there. Download one now
and then for an off-site copy. To restore: stop the app, replace `brt-data/regattas.db` with the
copy (and delete `regattas.db-wal` and `regattas.db-shm`), then start it.

## Troubleshooting

- **Connecting… forever** (the page loads, `/api/health` works, but the header never shows
  **Live**): the host's web server isn't passing WebSocket connections to the app. Ask Exabytes
  support: *"Please enable WebSocket connections to my Node.js application at race.yourdomain
  (path /ws)."* TMTRAC uses WebSockets on the same hosting, so it should already work.
- **The old version keeps running after an update:** press **Restart** in Setup Node.js App.
- **No Node 22.13 or later in the list:** ask Exabytes to add it; the server needs Node's built-in
  SQLite.
- **"That admin token is not right"**: it must match `ADMIN_TOKEN` in Setup Node.js App exactly.
  After changing it there, press **Restart**.
- **Logs:** Setup Node.js App shows where the app's log file is (often `stderr.log` in the
  application root). The first line after a start reads
  `Boat Race Tracker server (Node v22…) listening on …`.
