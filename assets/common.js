// =====================================================================
// Shared DOM/formatting helpers used by both owner.js and worker.js.
// Nothing in here depends on app-specific state.
// =====================================================================
window.HD_COMMON = (function () {
  "use strict";

  function el(html) {
    var d = document.createElement('template');
    d.innerHTML = html.trim();
    return d.content.firstChild;
  }
  function esc(s) {
    return (s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function qtyLabel(q, unit) { return Number(q || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' ' + unit; }
  function fmtWhen(d) {
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ', ' +
      d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }
  function placeholderPhoto() {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#E4E6EB"/>' +
      '<g fill="#9CA3AF"><circle cx="100" cy="82" r="26"/><path d="M40 168c6-38 34-58 60-58s54 20 60 58"/></g></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function disableWheelChange(inputEl) {
    inputEl.addEventListener('wheel', function (e) {
      if (document.activeElement === inputEl) e.preventDefault();
    }, { passive: false });
  }
  // Shrinks a photo BEFORE it ever becomes a data URL saved to the
  // database. A phone camera photo is routinely 2-5MB at full resolution
  // — far bigger than this app's catalogue grid or item screen ever
  // displays it — and since photos are stored as text directly inside a
  // product's row (see the "Important Things to Know" callout in the
  // deployment guide), every uncompressed photo was quietly eating into
  // the database's size budget. This resizes the longest side down to
  // maxDim pixels (plenty for how this app displays photos — a 1:1 tile
  // in a grid, or a bit bigger on the item screen) and re-encodes as a
  // JPEG at the given quality, typically shrinking a raw camera photo by
  // 20-50x with no visible loss for a product-catalogue photo. Note this
  // always outputs JPEG (drops transparency) — fine for real-world photos
  // of products, which is all this is ever used for.
  // Resolves to a data URL, same shape as before — no other code (or the
  // database column) needs to change to benefit from this.
  function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 800;
    quality = quality || 0.75;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('read failed')); };
      reader.onload = function (e) {
        var img = new Image();
        img.onerror = function () { reject(new Error('decode failed')); };
        img.onload = function () {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var outW = Math.max(1, Math.round(w * scale)), outH = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = outW; canvas.height = outH;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, outW, outH);
          try {
            resolve(canvas.toDataURL('image/jpeg', quality));
          } catch (err) { reject(err); }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function toast(msg) {
    var el2 = document.getElementById('toast');
    if (!el2) return;
    el2.textContent = msg; el2.classList.add('show');
    clearTimeout(el2._h); el2._h = setTimeout(function () { el2.classList.remove('show'); }, 1800);
  }
  // Strips spaces/dashes/+91/leading-0 so a phone number typed two
  // different ways (by an owner adding a worker vs. the worker logging
  // in themselves) still compares equal. Only touches the shape that's
  // unambiguously a 10-digit Indian mobile number with a country code or
  // trunk prefix attached — a plain 10-digit number is never altered.
  function normalizePhone(phone) {
    var digits = (phone || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.indexOf('91') === 0) digits = digits.slice(2);
    else if (digits.length === 11 && digits.indexOf('0') === 0) digits = digits.slice(1);
    return digits;
  }
  // Validates an ALREADY-NORMALIZED phone number (run normalizePhone()
  // on it first, so "+91 98765 43210" or "098765 43210" aren't unfairly
  // rejected for their raw length). Real Indian mobile numbers are
  // exactly 10 digits and start with 6, 7, 8 or 9. On top of that, this
  // rejects a handful of obviously-fake numbers people sometimes type
  // to breeze through a form: all ten digits the same (9999999999), a
  // two-digit alternating pattern (9898989898), and a straight run of
  // consecutive digits in either direction — including ones that wrap
  // past 9 back to 0, like 6789012345 or 9876543210.
  // Returns null when the number is fine, or a short reason code
  // otherwise: 'length' | 'prefix' | 'repeating' | 'sequential'.
  function validatePhone(digits) {
    digits = digits || '';
    if (!/^[0-9]{10}$/.test(digits)) return 'length';
    if (!/^[6-9]/.test(digits)) return 'prefix';
    if (/^(\d)\1{9}$/.test(digits)) return 'repeating';
    if (/^(\d\d)\1{4}$/.test(digits)) return 'repeating';
    var ascending = true, descending = true;
    for (var i = 1; i < digits.length; i++) {
      var prev = Number(digits[i - 1]), cur = Number(digits[i]);
      if (cur !== (prev + 1) % 10) ascending = false;
      if (cur !== (prev + 9) % 10) descending = false;
    }
    if (ascending || descending) return 'sequential';
    return null;
  }
  function phoneErrorKey(reason) {
    return {
      length: 'phoneErrLength', prefix: 'phoneErrPrefix',
      repeating: 'phoneErrRepeating', sequential: 'phoneErrSequential'
    }[reason] || 'phoneErrLength';
  }
  function debounce(fn, wait) {
    var h;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(h);
      h = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }
  function matchScore(q, text) {
    q = (q || '').trim().toLowerCase(); text = (text || '').toLowerCase();
    if (!q) return 1;
    if (text.indexOf(q) === 0) return 3;
    if (text.indexOf(q) !== -1) return 2;
    var qi = 0; for (var i = 0; i < text.length && qi < q.length; i++) { if (text[i] === q[qi]) qi++; }
    return qi === q.length ? 1 : 0;
  }
  function fieldTemplate(label, type, name, placeholder, maxlen) {
    var f = el('<div class="field"></div>');
    f.appendChild(el('<label class="label">' + esc(label) + '</label>'));
    var inp = el('<input class="input" type="' + type + '" placeholder="' + esc(placeholder || '') + '">');
    inp.name = name;
    if (maxlen) inp.maxLength = maxlen;
    if (type === 'password') { inp.setAttribute('inputmode', 'numeric'); inp.setAttribute('pattern', '[0-9]*'); }
    if (type === 'tel') inp.setAttribute('inputmode', 'tel');
    f.appendChild(inp);
    return f;
  }
  function paginate(list, page, pageSize) {
    var totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    page = Math.min(Math.max(1, page), totalPages);
    var start = (page - 1) * pageSize;
    return { pageItems: list.slice(start, start + pageSize), page: page, totalPages: totalPages };
  }
  function pagerRow(page, totalPages, onPrev, onNext, t) {
    if (totalPages <= 1) return el('<div></div>');
    var row = el('<div class="pager"></div>');
    var prev = el('<button>‹</button>'); prev.disabled = page <= 1; prev.onclick = onPrev;
    var info = el('<span class="pageinfo">' + esc(t('pageInfo', page, totalPages)) + '</span>');
    var next = el('<button>›</button>'); next.disabled = page >= totalPages; next.onclick = onNext;
    row.appendChild(prev); row.appendChild(info); row.appendChild(next);
    return row;
  }
  // ---------------- offline banner ----------------
  // A small fixed banner + toast on connectivity changes. Lives outside
  // the app's own render() tree (appended straight to <body>) so it
  // survives every route re-render without owner.js/worker.js having to
  // know about it. Call HD_COMMON.initOfflineBanner(t) once at startup.
  var offlineBannerEl = null;
  function initOfflineBanner(t) {
    if (offlineBannerEl) return; // already initialised
    offlineBannerEl = el('<div class="offline-banner">' + esc(t('offlineBanner')) + '</div>');
    document.body.appendChild(offlineBannerEl);
    function sync() {
      if (navigator.onLine) offlineBannerEl.classList.remove('show');
      else offlineBannerEl.classList.add('show');
    }
    window.addEventListener('online', function () { sync(); toast(t('backOnlineToast')); });
    window.addEventListener('offline', function () { sync(); toast(t('wentOfflineToast')); });
    sync();
  }

  // ---------------- back-button trap + confirm-before-exit ----------------
  // Makes the hardware/browser back button navigate WITHIN the app (via
  // onBack, supplied by owner.js/worker.js — it knows its own screen
  // history) instead of leaving immediately. When onBack reports there's
  // nowhere left to go (the app's own root screen), this shows a confirm
  // dialog and only actually exits if the person confirms.
  //
  // How it works: one extra, invisible history entry is kept "underneath"
  // the current screen at all times. Pressing back consumes it and fires
  // popstate; we either re-arm it (rendering the previous in-app screen)
  // or, at the root, ask for confirmation and only let the exit through
  // (via history.back()) if confirmed.
  //
  // Covers the browser back button/gesture and, on Android, the hardware
  // back button in an installed ("Add to Home Screen") app — both use the
  // same page history under the hood. There is no equivalent hook for the
  // iPhone home-button/app-switcher gesture — no web page can intercept
  // that on iOS, installed or not.
  function armExitGuard() {
    try { history.pushState({ hd: true }, '', location.href); } catch (e) {}
  }
  function initBackNav(onBack) {
    armExitGuard();
    window.addEventListener('popstate', function () { onBack(); });
  }
  function confirmExit(t) {
    showConfirm({
      title: t('exitConfirmTitle'), body: t('exitConfirmBody'),
      confirmLabel: t('exitConfirmYes'), cancelLabel: t('cancelBtn'), danger: true,
      onConfirm: function () { try { history.back(); } catch (e) {} }
    });
    // Re-arm immediately so a cancel (dialog dismissed without confirming)
    // still leaves the trap active for the next back press. If the user
    // DID confirm, this extra guard entry is harmless — history.back()
    // above still lands one step further back, past it.
    armExitGuard();
  }
  // ---------------- app-update banner ----------------
  // Tells the person a new version of the app is ready (the service
  // worker downloaded it in the background) and reloads once they tap it
  // — this is what makes code changes you deploy later actually reach a
  // device that already installed the app, instead of it being stuck
  // showing whatever was cached the first time it was opened.
  function initUpdateBanner(t) {
    if (!('serviceWorker' in navigator)) return;
    // Only reload the page when WE'RE the ones who asked the new worker to
    // take over (the person tapped the "Update available" banner below).
    // Without this flag, the browser's own "controllerchange" event also
    // fires on a brand-new visitor's very first load — the service worker
    // takes control of the page moments after it first paints even though
    // nothing is being "updated" — which used to silently reload the page
    // out from under a first-time visitor (e.g. mid-signup, before they'd
    // typed anything). This makes the reload fire only for a real update.
    var updateRequested = false;
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) return;
      function showBannerFor(worker) {
        var bar = el('<div class="update-banner">' + esc(t('updateAvailable')) + '</div>');
        document.body.appendChild(bar);
        requestAnimationFrame(function () { bar.classList.add('show'); });
        bar.onclick = function () {
          updateRequested = true;
          worker.postMessage({ type: 'SKIP_WAITING' });
        };
      }
      if (reg.waiting) showBannerFor(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showBannerFor(nw);
        });
      });
    }).catch(function () {});
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!updateRequested || reloading) return;
      reloading = true;
      location.reload();
    });
  }

  // ---------------- install-app banner ----------------
  // Chrome/Edge/Android decide entirely on their own, using internal
  // heuristics, when (and whether) to show their built-in "Add to Home
  // screen" mini-banner — in practice this often means it shows once,
  // ever, on a device, no matter how many more times someone reopens the
  // link without actually installing. Capturing the underlying
  // `beforeinstallprompt` event ourselves and calling preventDefault()
  // stops that browser-controlled one-off banner, and lets us show our
  // OWN banner instead — one that reappears on every visit for as long as
  // the app hasn't been installed yet, which is what a first-time,
  // unfamiliar-with-PWAs shopkeeper actually needs. Nothing here is
  // stored in localStorage on purpose: a "closed for now" tap only hides
  // it for the rest of this page view, never permanently — the very next
  // time the link is opened, it's back, right up until install.
  //
  // iOS Safari never fires beforeinstallprompt at all (an Apple platform
  // restriction, not something any web page can work around) and there is
  // no way to trigger the Add to Home Screen action or detect that it
  // happened from page code — so on iOS this shows a plain instructional
  // banner instead, on every visit, for as long as the page isn't already
  // running as an installed app.
  function initInstallPrompt(t) {
    // Already launched from a home-screen icon (installed) on either
    // platform's way of reporting it — nothing left to prompt for.
    if ((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true) return;

    var bar = null;
    function positionBar() {
      if (!bar) return;
      // Sits just below the offline banner when that's also showing, so
      // the two never overlap each other at the top of the screen.
      var top = (offlineBannerEl && offlineBannerEl.classList.contains('show')) ? offlineBannerEl.offsetHeight : 0;
      bar.style.top = top + 'px';
    }
    function showBar(onTap) {
      if (bar) return;
      bar = el(
        '<div class="install-banner"><span class="install-txt"></span>' +
        '<button type="button" class="install-btn"></button>' +
        '<button type="button" class="install-x">✕</button></div>'
      );
      bar.querySelector('.install-txt').textContent = t('installBannerText');
      var btn = bar.querySelector('.install-btn');
      btn.textContent = t('installBannerBtn');
      btn.onclick = onTap;
      // Closing only dismisses THIS page view — nothing is remembered, so
      // it comes right back on the next visit, by design.
      bar.querySelector('.install-x').onclick = function () { bar.remove(); bar = null; };
      document.body.appendChild(bar);
      positionBar();
      requestAnimationFrame(function () { if (bar) bar.classList.add('show'); });
    }
    window.addEventListener('online', positionBar);
    window.addEventListener('offline', positionBar);

    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      showBar(function () {
        showModal({ title: t('installBannerBtn'), bodyHtml: '<div style="font-size:13.5px;line-height:1.5;">' + esc(t('iosInstallSteps')) + '</div>', closeLabel: t('closeBtn') });
      });
      return;
    }

    var deferred = null;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      showBar(function () {
        if (!deferred) return;
        var toPrompt = deferred;
        deferred = null;
        toPrompt.prompt();
      });
    });
    window.addEventListener('appinstalled', function () {
      if (bar) { bar.remove(); bar = null; }
    });
  }

  function closeOverlay() {
    var root = document.getElementById('overlayRoot');
    if (root) root.innerHTML = '';
    // The tour's own onRender() hook only fires from owner.js's render(),
    // which never touches #overlayRoot — so every place that opens or
    // closes something in #overlayRoot calls this too, letting the tour
    // notice and relocate whenever a popup appears or disappears.
    if (window.HD_TOUR) window.HD_TOUR.onRender();
  }
  function showConfirm(opts) {
    var root = document.getElementById('overlayRoot');
    if (!root) return;
    var dlg = el(
      '<div class="overlay"><div class="dialog">' +
        '<h3>' + esc(opts.title) + '</h3><p>' + esc(opts.body) + '</p>' +
        '<div class="btn-row">' +
          '<button class="btn btn-ghost" id="ovCancel">' + esc(opts.cancelLabel) + '</button>' +
          '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" id="ovConfirm">' + esc(opts.confirmLabel) + '</button>' +
        '</div>' +
      '</div></div>'
    );
    root.innerHTML = ''; root.appendChild(dlg);
    dlg.querySelector('#ovCancel').onclick = closeOverlay;
    dlg.querySelector('#ovConfirm').onclick = function () { closeOverlay(); opts.onConfirm(); };
    dlg.onclick = function (e) { if (e.target === dlg) closeOverlay(); };
    if (window.HD_TOUR) window.HD_TOUR.onRender();
  }

  // A view-only popup (e.g. "here's the price history") — no Yes/No choice,
  // just content plus a close control. The close button carries both a ✕
  // icon and a short word (never icon-only) so it's unambiguous even to
  // someone who doesn't reliably read symbols. Clicking outside the box
  // closes it too, same as showConfirm().
  function showModal(opts) {
    var root = document.getElementById('overlayRoot');
    if (!root) return;
    var dlg = el(
      '<div class="overlay"><div class="dialog" style="position:relative;">' +
        '<button type="button" class="modal-close" id="mdClose"><span class="mc-x">✕</span><span class="mc-lbl">' + esc(opts.closeLabel) + '</span></button>' +
        '<h3>' + esc(opts.title) + '</h3>' +
        '<div class="modal-body">' + opts.bodyHtml + '</div>' +
      '</div></div>'
    );
    root.innerHTML = ''; root.appendChild(dlg);
    dlg.querySelector('#mdClose').onclick = closeOverlay;
    dlg.onclick = function (e) { if (e.target === dlg) closeOverlay(); };
    if (window.HD_TOUR) window.HD_TOUR.onRender();
  }

  // A short list of tappable choices (icon + label each) plus a cancel
  // row — used where a plain Yes/No confirm doesn't fit, e.g. "how do you
  // want to add a photo?". opts: { title, actions: [{icon, label, onClick}], cancelLabel }
  function showActionSheet(opts) {
    var root = document.getElementById('overlayRoot');
    if (!root) return;
    var rowsHtml = opts.actions.map(function (a, i) {
      return '<button type="button" class="sheet-row" data-i="' + i + '">' +
        '<span class="sheet-ic">' + esc(a.icon || '') + '</span>' +
        '<span class="sheet-lbl">' + esc(a.label) + '</span></button>';
    }).join('');
    var dlg = el(
      '<div class="overlay"><div class="dialog">' +
        (opts.title ? '<h3>' + esc(opts.title) + '</h3>' : '') +
        '<div class="sheet-rows">' + rowsHtml + '</div>' +
        '<button type="button" class="btn btn-ghost btn-block" id="shCancel">' + esc(opts.cancelLabel) + '</button>' +
      '</div></div>'
    );
    root.innerHTML = ''; root.appendChild(dlg);
    opts.actions.forEach(function (a, i) {
      dlg.querySelector('.sheet-row[data-i="' + i + '"]').onclick = function () { closeOverlay(); a.onClick(); };
    });
    dlg.querySelector('#shCancel').onclick = closeOverlay;
    dlg.onclick = function (e) { if (e.target === dlg) closeOverlay(); };
    if (window.HD_TOUR) window.HD_TOUR.onRender();
  }

  return {
    el: el, esc: esc, money: money, qtyLabel: qtyLabel, fmtWhen: fmtWhen,
    placeholderPhoto: placeholderPhoto, disableWheelChange: disableWheelChange,
    toast: toast, matchScore: matchScore, fieldTemplate: fieldTemplate,
    paginate: paginate, pagerRow: pagerRow, showConfirm: showConfirm, closeOverlay: closeOverlay,
    initOfflineBanner: initOfflineBanner, normalizePhone: normalizePhone, debounce: debounce,
    initBackNav: initBackNav, armExitGuard: armExitGuard, confirmExit: confirmExit,
    initUpdateBanner: initUpdateBanner, validatePhone: validatePhone, phoneErrorKey: phoneErrorKey,
    compressImage: compressImage, showModal: showModal, showActionSheet: showActionSheet,
    initInstallPrompt: initInstallPrompt
  };
})();
