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
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) return;
      function showBannerFor(worker) {
        var bar = el('<div class="update-banner">' + esc(t('updateAvailable')) + '</div>');
        document.body.appendChild(bar);
        requestAnimationFrame(function () { bar.classList.add('show'); });
        bar.onclick = function () {
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
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }

  function closeOverlay() {
    var root = document.getElementById('overlayRoot');
    if (root) root.innerHTML = '';
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
  }

  return {
    el: el, esc: esc, money: money, qtyLabel: qtyLabel, fmtWhen: fmtWhen,
    placeholderPhoto: placeholderPhoto, disableWheelChange: disableWheelChange,
    toast: toast, matchScore: matchScore, fieldTemplate: fieldTemplate,
    paginate: paginate, pagerRow: pagerRow, showConfirm: showConfirm, closeOverlay: closeOverlay,
    initOfflineBanner: initOfflineBanner, normalizePhone: normalizePhone, debounce: debounce,
    initBackNav: initBackNav, armExitGuard: armExitGuard, confirmExit: confirmExit,
    initUpdateBanner: initUpdateBanner, validatePhone: validatePhone, phoneErrorKey: phoneErrorKey
  };
})();
