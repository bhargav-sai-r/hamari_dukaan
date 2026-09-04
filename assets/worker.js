// =====================================================================
// Worker app — view-only: search the catalogue, see photo/description/
// selling price. No editing, no cost prices, no worker management.
//
// This is a UNIVERSAL login: a worker's phone number + PIN alone
// determines which one store they belong to (one phone number maps to
// exactly one store, ever) — there is no "select a store" step here.
//
// The login is remembered on this device — once logged in, opening the
// app again goes straight into the catalogue, no phone number/PIN
// needed again, until "Log out" is used.
//
// Depends on (load these script tags before this one):
//   assets/config.js, assets/i18n.js, assets/common.js, assets/api.js
// =====================================================================
(function () {
  "use strict";

  var C = window.HD_COMMON;
  var api = window.HD_API;
  var DEMO_MODE = window.HD_CONFIG.DEMO_MODE;
  var el = C.el, esc = C.esc, money = C.money, placeholderPhoto = C.placeholderPhoto,
      toast = C.toast, matchScore = C.matchScore, fieldTemplate = C.fieldTemplate,
      paginate = C.paginate, pagerRow = C.pagerRow, showConfirm = C.showConfirm, normalizePhone = C.normalizePhone,
      validatePhone = C.validatePhone, phoneErrorKey = C.phoneErrorKey;

  function blank() {
    return {
      lang: 'en',
      storeId: null, storeName: null, workerId: null, workerName: null, skus: [], session: null,
      nav: { query: '', page: 1, editingId: null, loginError: '', menuOpen: false, busy: false }
    };
  }
  var S = blank();
  var PAGE_SIZE = 12;
  var route = 'booting';
  var navStack = [];

  function t(key, a, b) { return window.HD_I18N.makeT(function () { return S.lang; })(key, a, b); }

  var SESSION_KEY = 'hd_worker_session';
  function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } }
  function saveSession() {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ storeId: S.storeId, storeName: S.storeName, workerId: S.workerId, workerName: S.workerName })); } catch (e) {}
  }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  function filteredSkus(q) {
    var scored = S.skus.map(function (s) { return { s: s, score: matchScore(q, s.name + ' ' + s.description) }; });
    scored = scored.filter(function (x) { return x.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score || a.s.name.localeCompare(b.s.name); });
    return scored.map(function (x) { return x.s; });
  }
  // A product the owner has removed from the catalogue shouldn't be
  // something a worker can still look up and quote a price on. Mirrors
  // owner.js's isActiveSku — see that file for why "!== false" (older
  // cached rows have no `active` field at all and should stay visible).
  function isActiveSku(s) { return s.active !== false; }
  function findSku(id) { return S.skus.filter(function (s) { return s.id === id; })[0]; }

  function go(r, patch, opts) {
    opts = opts || {};
    if (opts.resetStack) navStack = [];
    else if (!opts.fromPop) navStack.push({ route: route, patch: Object.assign({}, S.nav) });
    route = r;
    if (patch) Object.keys(patch).forEach(function (k) { S.nav[k] = patch[k]; });
    C.armExitGuard();
    render();
  }
  function handleBack() {
    if (navStack.length) { var prev = navStack.pop(); go(prev.route, prev.patch, { fromPop: true }); }
    else C.confirmExit(t);
  }

  function boot() {
    var session = loadSession();
    if (!session || !session.storeId) { route = 'login'; render(); return; }
    S.storeId = session.storeId; S.storeName = session.storeName;
    S.workerId = session.workerId; S.workerName = session.workerName;
    S.session = { role: 'worker' };
    api.listSkus(S.storeId).then(function (skus) {
      S.skus = skus;
      go('catalogue', null, { resetStack: true });
    }).catch(function () {
      // Nothing cached and can't reach the server — still let them in with
      // an empty list rather than getting stuck; catalogue shows the
      // "nothing yet" empty state and will fill in once back online.
      go('catalogue', null, { resetStack: true });
    });
  }

  var app = document.getElementById('app');

  function render() {
    app.innerHTML = '';
    var chrome = route !== 'login' && route !== 'booting';
    if (chrome) app.appendChild(renderAppbar());
    var main = el('<div class="main scroll"></div>');
    var center = el('<div class="center-wrap"></div>');
    if (!chrome) {
      var langRow = el('<div style="display:flex;justify-content:flex-end;"></div>');
      langRow.appendChild(langToggle());
      center.appendChild(langRow);
    }
    center.appendChild(renderRoute());
    main.appendChild(center);
    app.appendChild(main);
  }

  function langToggle() {
    var next = S.lang === 'en' ? 'hi' : 'en';
    var label = S.lang === 'en' ? 'हिंग्लिश' : 'English';
    var b = el('<button class="langtoggle">' + esc(label) + '</button>');
    b.onclick = function () { S.lang = next; render(); };
    return b;
  }

  function renderAppbar() {
    var bar = el(
      '<div class="appbar">' +
        '<div class="meta"><div class="shopname">' + esc(S.storeName || 'Hamari Dukaan') + '</div>' +
        '<span class="rolepill">' + esc(t('workerBadge')) + '</span></div>' +
      '</div>'
    );
    bar.appendChild(langToggle());
    var logoutBtn = el('<button class="icon-btn danger" title="Logout">⏻</button>');
    logoutBtn.onclick = function () {
      showConfirm({ title: t('logoutConfirmTitle'), body: t('workerLogoutConfirmBody'), confirmLabel: t('logoutConfirmYes'),
        cancelLabel: t('cancelBtn'), danger: true,
        onConfirm: function () { clearSession(); var lang = S.lang; S = blank(); S.lang = lang; go('login', null, { resetStack: true }); } });
    };
    bar.appendChild(logoutBtn);
    return bar;
  }

  function renderRoute() {
    switch (route) {
      case 'booting': return el('<div style="padding-top:80px;text-align:center;color:var(--ink-muted);">' + esc(t('loadingText')) + '</div>');
      case 'login': return renderLogin();
      case 'catalogue': return renderCatalogue();
      case 'item': return renderItem();
      default: return el('<div></div>');
    }
  }

  function renderLogin() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:16px;padding-top:26px;"></div>');
    wrap.appendChild(el('<div style="text-align:center;font-size:36px;">🏪</div>'));
    wrap.appendChild(el('<h2 class="subtitle" style="text-align:center;">' + esc(t('workerWelcomeTitle')) + '</h2>'));
    wrap.appendChild(el('<p class="lede" style="text-align:center;">' + esc(t('workerWelcomeSub')) + '</p>'));
    wrap.appendChild(el('<div class="entry-badge">' + esc(t('workerEntryBadge')) + '</div>'));
    if (DEMO_MODE) wrap.appendChild(el('<div class="demo-chip">' + esc(t('demoModeChip')) + '</div>'));
    var f = el('<form style="display:flex;flex-direction:column;gap:14px;"></form>');
    f.appendChild(fieldTemplate(t('phoneLabel'), 'tel', 'phone', t('phonePh')));
    f.appendChild(fieldTemplate(t('pinLabel'), 'password', 'pin', t('pinPh'), '4'));
    if (S.nav.loginError) f.appendChild(el('<div class="banner banner-danger">⚠ ' + esc(S.nav.loginError) + '</div>'));
    var submitBtn = el('<button type="submit" class="btn btn-primary btn-block">' + esc(t('loginBtn')) + '</button>');
    f.appendChild(submitBtn);
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var phone = normalizePhone(f.phone.value), pin = f.pin.value.trim();
      var phoneErr = validatePhone(phone);
      if (phoneErr) { S.nav.loginError = t(phoneErrorKey(phoneErr)); render(); return; }
      submitBtn.disabled = true; submitBtn.textContent = t('savingText');
      api.loginWorker(phone, pin).then(function (result) {
        if (!result) {
          S.nav.loginError = t('loginError');
          submitBtn.disabled = false; submitBtn.textContent = t('loginBtn');
          render();
          return;
        }
        S.storeId = result.store_id; S.storeName = result.store_name;
        S.workerId = result.worker_id; S.workerName = result.worker_name;
        S.session = { role: 'worker' };
        saveSession();
        api.listSkus(S.storeId).then(function (skus) {
          S.skus = skus;
          toast(t('welcomeBackToast'));
          go('catalogue', null, { resetStack: true });
        });
      }).catch(function () {
        S.nav.loginError = t('genericError');
        submitBtn.disabled = false; submitBtn.textContent = t('loginBtn');
        render();
      });
    };
    wrap.appendChild(f);
    return wrap;
  }

  var debouncedRender = C.debounce(function () {
    render();
    var again = document.getElementById('searchInput');
    if (again) { again.focus(); again.selectionStart = again.selectionEnd = again.value.length; }
  }, 120);

  function renderCatalogue() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:10px;"></div>');
    var searchWrap = el('<div class="search-wrap"><span class="search-icon">🔍</span><input class="input" placeholder="' + esc(t('searchPh')) + '" id="searchInput"></div>');
    var inp = searchWrap.querySelector('#searchInput');
    inp.value = S.nav.query;
    inp.oninput = function () {
      S.nav.query = inp.value; S.nav.page = 1;
      debouncedRender();
    };
    wrap.appendChild(searchWrap);

    var q = S.nav.query;
    var results = filteredSkus(q).filter(isActiveSku);
    if (!S.skus.length) {
      wrap.appendChild(el('<div class="empty-state"><div class="big">🗂️</div><div>' + esc(t('emptyCatalogueWorker')) + '</div></div>'));
    } else if (!results.length) {
      wrap.appendChild(el('<div class="empty-state">' + esc(t('noMatch', q)) + '</div>'));
    } else {
      var pg = paginate(results, S.nav.page, PAGE_SIZE);
      var grid = el('<div class="card-grid"></div>');
      pg.pageItems.forEach(function (s) { grid.appendChild(skuCard(s)); });
      wrap.appendChild(grid);
      wrap.appendChild(pagerRow(pg.page, pg.totalPages,
        function () { S.nav.page--; render(); },
        function () { S.nav.page++; render(); }, t));
    }
    return wrap;
  }

  // MRP is stored as null on any product that predates round 4.9's MRP
  // field — shown as a dash rather than ₹0, since that's not a real price.
  function mrpDisplay(s) { return (s.mrp === null || s.mrp === undefined || s.mrp === '') ? '—' : money(s.mrp); }

  function skuCard(s) {
    var card = el(
      '<div class="sku-card">' +
        '<img class="sku-photo" src="' + (s.photo || placeholderPhoto()) + '">' +
        '<div class="sku-body"><div class="sku-name">' + esc(s.name) + '</div>' +
          '<div class="sku-price">' + t('spShort') + ' ' + money(s.sell) + ' · ' + t('mrpLabel') + ' ' + mrpDisplay(s) + '</div></div>' +
      '</div>'
    );
    card.onclick = function () { go('item', { editingId: s.id }); };
    return card;
  }

  function renderItem() {
    var s = findSku(S.nav.editingId);
    var wrap = el('<div style="display:flex;flex-direction:column;gap:14px;"></div>');
    if (!s) { wrap.appendChild(el('<div class="empty-state">Not found.</div>')); return wrap; }
    wrap.appendChild(el('<img src="' + (s.photo || placeholderPhoto()) + '" style="width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:14px;background:var(--surface-muted);">'));
    wrap.appendChild(el('<div style="font-family:var(--font-display);font-size:20px;font-weight:700;">' + esc(s.name) + '</div>'));
    if (s.description) wrap.appendChild(el('<div style="font-size:14px;color:var(--ink-muted);line-height:1.5;">' + esc(s.description) + '</div>'));
    // Selling Price and MRP shown side by side, colour-coded the same way
    // as the owner's screens (green = selling, grey = MRP) so a colour
    // means the same thing everywhere in the app (round 4.10).
    var priceRow = el('<div class="stat-row"></div>');
    priceRow.appendChild(el('<div class="stat-box pc-sell"><div class="k">' + esc(t('sellStat')) + '</div><div class="v">' + money(s.sell) + '</div></div>'));
    priceRow.appendChild(el('<div class="stat-box pc-mrp"><div class="k">' + esc(t('mrpLabel')) + '</div><div class="v">' + mrpDisplay(s) + '</div></div>'));
    wrap.appendChild(priceRow);
    var back = el('<button class="btn btn-ghost btn-block">' + esc(t('backBtn')) + '</button>');
    back.onclick = function () { go('catalogue'); };
    wrap.appendChild(back);
    return wrap;
  }

  C.initOfflineBanner(t);
  C.initUpdateBanner(t);
  C.initInstallPrompt(t);
  C.initBackNav(handleBack);
  boot();
})();
