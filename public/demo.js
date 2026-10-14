// Demo site (the server runs with DEMO=1): a free host wipes its disk when the site sleeps, so the browser keeps a copy
// of every trip this visitor saves and puts it back when the server has lost it. Does nothing on a normal install.
// Loaded before app.js: it wraps fetch, and trip requests wait until /api/status says whether this is the demo.
(() => {
  const realFetch = window.fetch.bind(window);
  const isDemo = realFetch("/api/status")
    .then((r) => r.json())
    .then((s) => !!s.demo)
    .catch(() => false);

  // IndexedDB: { id -> the trip as last saved (the PUT body) }
  let dbP = null;
  const db = () =>
    (dbP ||= new Promise((ok, fail) => {
      const req = indexedDB.open("byway-demo", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("trips");
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((ok, fail) => {
      const t = d.transaction("trips", mode);
      const r = fn(t.objectStore("trips"));
      t.oncomplete = () => ok(r?.result);
      t.onerror = () => fail(t.error);
    });
  };
  const keep = (id, body) => tx("readwrite", (s) => s.put(body, id)).catch(() => {});
  const forget = (id) => tx("readwrite", (s) => s.delete(id)).catch(() => {});
  const copyOf = (id) => tx("readonly", (s) => s.get(id)).catch(() => null);
  const allIds = () => tx("readonly", (s) => s.getAllKeys()).catch(() => []);
  const putBack = (id, body) =>
    realFetch(`/api/trips/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body }).catch(() => null);

  // Once per page: the trips this browser has that the server lost (it slept, or was redeployed) go back up.
  let synced = null;
  const sync = () =>
    (synced ||= (async () => {
      const have = new Set((((await (await realFetch("/api/trips")).json()) || {}).trips || []).map((t) => t.id));
      for (const id of await allIds()) {
        if (have.has(id)) continue;
        const body = await copyOf(id);
        if (body) await putBack(id, body);
      }
    })().catch(() => {}));

  const ONE = /^\/api\/trips\/([a-z0-9-]{6,40})$/;
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const method = (init.method || (typeof input === "string" ? "GET" : input.method) || "GET").toUpperCase();
    const trips = url.origin === location.origin && url.pathname.startsWith("/api/trips");
    if (!trips || !(await isDemo)) return realFetch(input, init);
    const one = ONE.exec(url.pathname)?.[1];
    if (url.pathname === "/api/trips" && method === "GET") await sync();
    const r = await realFetch(input, init);
    if (one && method === "PUT" && r.ok && typeof init.body === "string") keep(one, init.body);
    if (one && method === "DELETE" && r.ok) forget(one);
    if (one && method === "GET" && r.status === 404) {
      const body = await copyOf(one);
      if (body && (await putBack(one, body))?.ok) return realFetch(input, init);
    }
    return r;
  };
})();
