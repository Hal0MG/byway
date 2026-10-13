// Byway as a desktop app (Electron): the same server runs inside the app and a window shows it, so there's no Node to
// install and no terminal to keep open. Trips, keys (.env) and caches live in the app's own data folder
// (Mac: ~/Library/Application Support/Byway, Windows: %APPDATA%\Byway), not inside the app, so updates keep them.
// Run it from a checkout with `npm run desktop`; `npm run desktop:build` makes the installers (see package.json).
const { app, BrowserWindow, shell } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// the first free port from 3000 up, so a copy started with start.sh can run alongside
const portFree = (port) =>
  new Promise((ok) => {
    const s = net.createServer();
    s.once("error", () => ok(false));
    s.once("listening", () => s.close(() => ok(true)));
    s.listen(port); // all addresses, like the server (a check on 127.0.0.1 alone missed a server on ::)
  });

let win = null;
async function start() {
  const home = app.getPath("userData");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  process.chdir(home);
  let port = 3000;
  while (!(await portFree(port))) port++;
  process.env.PORT = String(port);
  await import(pathToFileURL(path.join(__dirname, "..", "server.js")).href);

  win = new BrowserWindow({ width: 1440, height: 920, minWidth: 380, backgroundColor: "#0a0a0c", title: "Byway", show: false });
  win.once("ready-to-show", () => win.show());
  // links out (Google Maps, booking sites, Wikipedia) open in the browser, not in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://localhost:${port}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  await win.loadURL(`http://localhost:${port}/`);

  // BYWAY_SMOKE=<file.png>: a check for builds (CI and by hand): wait for the app to draw, save a screenshot, quit
  if (process.env.BYWAY_SMOKE) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.BYWAY_SMOKE, img.toPNG());
      console.log(`Saved ${process.env.BYWAY_SMOKE}`);
      app.exit(0);
    }, Number(process.env.BYWAY_SMOKE_WAIT || 8000));
  }
}

// one copy at a time: opening it again brings the window back
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start).catch((e) => {
    console.error(e);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
