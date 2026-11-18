const cacheName = "x402-shell-v1";
const shell = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then(async (cache) => {
    await cache.addAll(shell);
    await self.skipWaiting();
  }));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then(async (keys) => {
    await Promise.all(keys.filter((key) => key.startsWith("x402-shell-") && key !== cacheName).map((key) => caches.delete(key)));
    await self.clients.claim();
  }));
});
self.addEventListener("message", (event) => {
  if (event.data !== "CACHE_SHELL_ASSETS") return;
  event.waitUntil(caches.open(cacheName).then(async (cache) => {
    const page = await cache.match("/");
    if (!page) return;
    const html = await page.text();
    const assets = Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), (match) => match[1]);
    await cache.addAll([...new Set(assets)]);
  }));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || request.headers.has("Authorization")
      || url.pathname.startsWith("/api/") || url.pathname.startsWith("/sandbox/") || url.pathname.startsWith("/.well-known/") || url.pathname === "/mcp") return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) await (await caches.open(cacheName)).put("/", response.clone());
      return response;
    }).catch(async () => await caches.match("/") ?? Response.error()));
  } else if (/^\/(assets|icons)\//.test(url.pathname) || shell.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await (await caches.open(cacheName)).put(request, response.clone());
      return response;
    }));
  }
});
