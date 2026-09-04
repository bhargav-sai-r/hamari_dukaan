// =====================================================================
// Service worker — makes the app shell (the HTML/CSS/JS that make up
// the app itself, NOT your product data) load even with no internet
// connection, and keeps it installable to a phone's home screen.
//
// IMPORTANT FOR WHOEVER EDITS assets/*.js OR assets/*.css LATER:
// Bump the number in CACHE_VERSION below every time you change any file
// in assets/, or index.html/worker.html. Otherwise returning visitors
// keep getting served the OLD cached copy instead of your update.
// =====================================================================
"use strict";

var CACHE_VERSION = "hd-shell-v9";
var RUNTIME_CACHE = "hd-runtime-v1";

// Everything needed to fully draw the app with zero network access.
// Paths are relative to this file's own location (the site root), so
// this still works correctly if the site is hosted under a sub-path
// (e.g. yourname.github.io/hamari-dukaan/) rather than a bare domain.
var SHELL_ASSETS = [
  "./",
  "./index.html",
  "./worker.html",
  "./manifest-owner.json",
  "./manifest-worker.json",
  "./assets/styles.css",
  "./assets/config.js",
  "./assets/i18n.js",
  "./assets/common.js",
  "./assets/api.js",
  "./assets/tour.js",
  "./assets/owner.js",
  "./assets/worker.js",
  "./assets/icons/owner-192.png",
  "./assets/icons/owner-512.png",
  "./assets/icons/owner-512-maskable.png",
  "./assets/icons/owner-apple-touch.png",
  "./assets/icons/worker-192.png",
  "./assets/icons/worker-512.png",
  "./assets/icons/worker-512-maskable.png",
  "./assets/icons/worker-apple-touch.png"
];

// Third-party hosts we're allowed to opportunistically cache (fonts +
// the Supabase client library). NEVER add your Supabase project's own
// host here — that's live data, not app shell, and must always be
// fetched fresh over the network.
var RUNTIME_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  var rel = url.pathname.replace(/^.*\/(index\.html|worker\.html|manifest-owner\.json|manifest-worker\.json|assets\/.+)$/, "$1");
  return SHELL_ASSETS.some(function (p) { return p.replace("./", "") === rel; }) || rel === "";
}

self.addEventListener("install", function (event) {
  // Deliberately NOT calling self.skipWaiting() here: when there's already
  // an older version of this app running, we want the NEW service worker
  // to sit "waiting" instead of taking over instantly — that's what lets
  // the app show an "Update available" banner and let the person choose
  // when to reload, instead of code changing out from under them mid-use.
  // (On a page's very first-ever install, with no old version running,
  // this makes no visible difference — it activates normally either way.)
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) { return cache.addAll(SHELL_ASSETS); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== CACHE_VERSION && k !== RUNTIME_CACHE) return caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// The update banner (assets/common.js: initUpdateBanner) sends this when
// the person taps it, so the new version takes over right away instead of
// waiting for every tab/window of the app to be closed and reopened.
self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Cache-first, refresh-in-background ("stale-while-revalidate") for the
// app shell — this is what makes the app itself open with no signal.
function shellStrategy(request) {
  return caches.open(CACHE_VERSION).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request).then(function (res) {
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      }).catch(function () { return null; });
      return cached || network || caches.match("./index.html");
    });
  });
}

// Network-first, cache-fallback for fonts / the Supabase JS library —
// keeps them fresh when online, but doesn't break the app if they're
// unreachable (e.g. the shop's wifi is up but flaky).
function runtimeStrategy(request) {
  return fetch(request).then(function (res) {
    if (res && res.ok) {
      caches.open(RUNTIME_CACHE).then(function (cache) { cache.put(request, res.clone()); });
    }
    return res;
  }).catch(function () {
    return caches.open(RUNTIME_CACHE).then(function (cache) { return cache.match(request); });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return; // never touch POST/RPC calls — those are live writes to Supabase

  var url = new URL(req.url);

  // Your Supabase project's own traffic (product data, logins) must
  // always go straight to the network — it is never cached here.
  if (url.hostname.indexOf("supabase.co") !== -1) return;

  if (req.mode === "navigate" || isShellRequest(url)) {
    event.respondWith(shellStrategy(req));
    return;
  }
  if (RUNTIME_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(runtimeStrategy(req));
  }
});
