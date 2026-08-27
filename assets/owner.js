// =====================================================================
// Owner app — cataloguing, receiving stock, order/price history, and
// worker management.
//
// One owner account (phone+PIN) can hold several stores. Logging in is
// a one-time thing per device: the session is remembered, so opening
// the app again goes straight into the last store used, or a plain
// store-picker if there's more than one — never back through the phone
// number + PIN form again. Adding another store, once logged in, only
// ever asks for a store name — never credentials.
//
// Depends on (load these script tags before this one):
//   assets/config.js, assets/i18n.js, assets/common.js, assets/api.js
// =====================================================================
(function () {
  "use strict";

  var C = window.HD_COMMON;
  var api = window.HD_API;
  var DEMO_MODE = window.HD_CONFIG.DEMO_MODE;
  var el = C.el, esc = C.esc, money = C.money, qtyLabel = C.qtyLabel, fmtWhen = C.fmtWhen,
      placeholderPhoto = C.placeholderPhoto, disableWheelChange = C.disableWheelChange,
      toast = C.toast, matchScore = C.matchScore, fieldTemplate = C.fieldTemplate,
      paginate = C.paginate, pagerRow = C.pagerRow, showConfirm = C.showConfirm, normalizePhone = C.normalizePhone,
      validatePhone = C.validatePhone, phoneErrorKey = C.phoneErrorKey;

  // ---------------- state ----------------
  function blank() {
    return {
      lang: 'en',
      ownerId: null, storeId: null, storeName: null, ownerStores: [], workers: [], skus: [], session: null,
      nav: { query: '', page: 1, receivePage: 1, editingId: null, context: 'catalogue', prefillName: '',
             receivedCount: 0, loginError: '', signupError: '', addStoreError: '', menuOpen: false,
             editingWorkerId: null, busy: false }
    };
  }
  var S = blank();
  var PAGE_SIZE = 12, ROW_PAGE_SIZE = 10;

  function t(key, a, b) { return window.HD_I18N.makeT(function () { return S.lang; })(key, a, b); }

  // ---------------- persisted session (this device stays logged in) ----------------
  var SESSION_KEY = 'hd_owner_session';
  var LAST_STORE_KEY = 'hd_owner_last_store';
  function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } }
  function saveSession(ownerId) { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ownerId: ownerId })); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(LAST_STORE_KEY); } catch (e) {} }
  function saveLastStore(storeId) { try { localStorage.setItem(LAST_STORE_KEY, String(storeId)); } catch (e) {} }
  function loadLastStore() { try { var v = localStorage.getItem(LAST_STORE_KEY); return v ? Number(v) : null; } catch (e) { return null; } }

  var route = 'booting';
  var navStack = [];
  var pendingPhoto = null;
  var original = null;

  function filteredSkus(q) {
    var scored = S.skus.map(function (s) { return { s: s, score: matchScore(q, s.name + ' ' + s.description) }; });
    scored = scored.filter(function (x) { return x.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score || a.s.name.localeCompare(b.s.name); });
    return scored.map(function (x) { return x.s; });
  }
  function findSku(id) { return S.skus.filter(function (s) { return s.id === id; })[0]; }
  function findWorker(id) { return S.workers.filter(function (w) { return w.id === id; })[0]; }

  // go(): every screen change goes through here. Normally it remembers
  // where you came from (so the back button can return to it); pass
  // {resetStack:true} when arriving at a new "home" screen (nothing to
  // go back to within the app — the back button should ask to exit from
  // here); pass {fromPop:true} only when re-rendering a screen the back
  // button itself is restoring (never call this yourself).
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

  function loadStoreData() {
    return Promise.all([api.listSkus(S.storeId), api.listWorkers(S.storeId)]).then(function (results) {
      S.skus = results[0]; S.workers = results[1];
    });
  }
  function enterStore(storeId, storeName) {
    S.storeId = storeId; S.storeName = storeName; S.session = { role: 'owner' };
    saveLastStore(storeId);
    return loadStoreData();
  }

  // ---------------- boot: restore a persisted session, if any ----------------
  function boot() {
    var session = loadSession();
    if (!session || !session.ownerId) { route = 'welcome'; render(); return; }
    S.ownerId = session.ownerId;
    api.listOwnerStores(S.ownerId).then(function (stores) {
      S.ownerStores = stores;
      if (!stores.length) { route = 'welcome'; render(); return; }
      var lastId = loadLastStore();
      var match = stores.filter(function (s) { return s.id === lastId; })[0] || (stores.length === 1 ? stores[0] : null);
      if (match) {
        enterStore(match.id, match.name).then(function () { go('catalogue', null, { resetStack: true }); });
      } else {
        go('storeSelect', null, { resetStack: true });
      }
    }).catch(function () {
      // Couldn't reach the server and nothing usable cached — fall back to
      // asking them to log in again rather than getting stuck on a blank screen.
      route = 'welcome'; render();
    });
  }

  // ---------------- root render ----------------
  var app = document.getElementById('app');

  function render() {
    app.innerHTML = '';
    var chrome = (route !== 'welcome' && route !== 'ownerSignup' && route !== 'login' && route !== 'storeSelect' && route !== 'booting');
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
    if (chrome && S.session && (route === 'catalogue' || route === 'receiveStock' || route === 'workers')) {
      app.appendChild(renderTabbar());
    }
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
        '<span class="rolepill">' + esc(t('ownerBadge')) + '</span></div>' +
      '</div>'
    );
    bar.appendChild(langToggle());
    var menuWrap = el('<div class="menu-wrap"></div>');
    var menuBtn = el('<button class="icon-btn">⋮</button>');
    menuWrap.appendChild(menuBtn);
    if (S.nav.menuOpen) {
      var pop = el('<div class="menu-pop"></div>');
      var switchItem = el('<div class="item">' + esc(t('switchStoreMenu')) + '</div>');
      switchItem.onclick = function () { S.nav.menuOpen = false; go('storeSelect'); };
      pop.appendChild(switchItem);
      if (DEMO_MODE) {
        var clearItem = el('<div class="item danger">' + esc(t('clearDataMenu')) + '</div>');
        clearItem.onclick = function () {
          S.nav.menuOpen = false;
          showConfirm({ title: t('clearDataTitle'), body: t('clearDataBody'), confirmLabel: t('clearDataYes'),
            cancelLabel: t('cancelBtn'), danger: true,
            onConfirm: function () { api.clearDemoData(); clearSession(); var lang = S.lang; S = blank(); S.lang = lang; go('welcome', null, { resetStack: true }); } });
        };
        pop.appendChild(clearItem);
      }
      menuWrap.appendChild(pop);
    }
    menuBtn.onclick = function () { S.nav.menuOpen = !S.nav.menuOpen; render(); };
    bar.appendChild(menuWrap);
    var logoutBtn = el('<button class="icon-btn danger" title="Logout">⏻</button>');
    logoutBtn.onclick = function () {
      showConfirm({ title: t('logoutConfirmTitle'), body: t('logoutConfirmBody'), confirmLabel: t('logoutConfirmYes'),
        cancelLabel: t('cancelBtn'), danger: true,
        onConfirm: function () {
          clearSession();
          var lang = S.lang; S = blank(); S.lang = lang;
          go('welcome', null, { resetStack: true });
        } });
    };
    bar.appendChild(logoutBtn);
    return bar;
  }

  function renderTabbar() {
    var tabs = [
      { key: 'catalogue', ic: '🗂', lb: t('tabCatalogue') },
      { key: 'receiveStock', ic: '📥', lb: t('tabReceive') },
      { key: 'workers', ic: '👥', lb: t('tabWorkers') }
    ];
    var bar = el('<div class="tabbar"></div>');
    tabs.forEach(function (tb) {
      var active = route === tb.key;
      var te = el('<div class="tab ' + (active ? 'active' : '') + '"><div class="ic">' + tb.ic + '</div><div class="lb">' + esc(tb.lb) + '</div></div>');
      te.onclick = function () { S.nav.query = ''; S.nav.page = 1; go(tb.key); };
      bar.appendChild(te);
    });
    return bar;
  }

  // ---------------- routes ----------------
  function renderRoute() {
    switch (route) {
      case 'booting': return el('<div style="padding-top:80px;text-align:center;color:var(--ink-muted);">' + esc(t('loadingText')) + '</div>');
      case 'welcome': return renderWelcome();
      case 'storeSelect': return renderStoreSelect();
      case 'addStore': return renderAddStore();
      case 'ownerSignup': return renderOwnerSignup();
      case 'login': return renderLogin();
      case 'catalogue': return renderCatalogue();
      case 'receiveStock': return renderReceiveStock();
      case 'workers': return renderWorkers();
      case 'workerEdit': return renderWorkerEdit();
      case 'item': return renderItem();
      default: return el('<div></div>');
    }
  }

  function renderWelcome() {
    var wrap = el(
      '<div style="display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding:60px 8px 10px;">' +
        '<div style="font-size:44px;">🏪</div>' +
        '<h1 class="title" style="background-image:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;">Hamari Dukaan</h1>' +
        '<p class="lede">' + esc(t('welcomeTagline')) + '</p>' +
      '</div>'
    );
    wrap.appendChild(el('<div class="entry-badge">' + esc(t('ownerEntryBadge')) + '</div>'));
    if (DEMO_MODE) wrap.appendChild(el('<div class="demo-chip">' + esc(t('demoModeChip')) + '</div>'));
    var btn = el('<button class="btn btn-grad btn-block">' + esc(t('createFirstStoreBtn')) + '</button>');
    btn.style.marginTop = '6px';
    btn.onclick = function () { S.nav.signupError = ''; go('ownerSignup'); };
    wrap.appendChild(btn);
    var loginLink = el('<button type="button" class="gallery-link">' + esc(t('alreadyHaveAccountLink')) + '</button>');
    loginLink.onclick = function () { S.nav.loginError = ''; go('login'); };
    wrap.appendChild(loginLink);
    return wrap;
  }

  function renderStoreSelect() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:14px;padding-top:26px;"></div>');
    wrap.appendChild(el('<div style="text-align:center;font-size:38px;">🏪</div>'));
    wrap.appendChild(el('<div><h2 class="subtitle" style="text-align:center;">' + esc(t('storeSelectTitle')) + '</h2>' +
      '<p class="lede" style="text-align:center;">' + esc(t('storeSelectSub')) + '</p></div>'));
    if (DEMO_MODE) wrap.appendChild(el('<div class="demo-chip">' + esc(t('demoModeChip')) + '</div>'));
    S.ownerStores.forEach(function (st) {
      var row = el(
        '<div class="worker-row"><div class="avatar">' + esc((st.name || '?').charAt(0).toUpperCase()) + '</div>' +
        '<div class="info"><div class="name">' + esc(st.name) + '</div><div class="sub">' + esc(t('tapToOpen')) + '</div></div>' +
        '<div class="chev">›</div></div>'
      );
      row.onclick = function () {
        enterStore(st.id, st.name).then(function () { go('catalogue', null, { resetStack: true }); });
      };
      wrap.appendChild(row);
    });
    var addBtn = el('<button class="btn btn-grad btn-block">' + esc(t('addAnotherStoreBtn')) + '</button>');
    addBtn.onclick = function () { S.nav.addStoreError = ''; go('addStore'); };
    wrap.appendChild(addBtn);
    return wrap;
  }

  // Adding a store while already logged in — just a name, nothing else.
  function renderAddStore() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:16px;padding-top:26px;"></div>');
    wrap.appendChild(el('<div><h2 class="subtitle">' + esc(t('addStoreTitle')) + '</h2><p class="lede">' + esc(t('addStoreSub')) + '</p></div>'));
    var f = el('<form style="display:flex;flex-direction:column;gap:14px;"></form>');
    f.appendChild(fieldTemplate(t('shopNameLabel'), 'text', 'shopName', t('shopNamePh')));
    if (S.nav.addStoreError) f.appendChild(el('<div class="banner banner-danger">⚠ ' + esc(S.nav.addStoreError) + '</div>'));
    var submitBtn = el('<button type="submit" class="btn btn-grad btn-block">' + esc(t('createAccountBtn')) + '</button>');
    f.appendChild(submitBtn);
    var back = el('<button type="button" class="btn btn-ghost btn-block">' + esc(t('backBtn')) + '</button>');
    back.onclick = function () { go('storeSelect'); };
    f.appendChild(back);
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var name = f.shopName.value.trim();
      if (!name) { S.nav.addStoreError = t('signupErrFill'); render(); return; }
      submitBtn.disabled = true; submitBtn.textContent = t('savingText');
      api.addStore(S.ownerId, name).then(function (store) {
        S.ownerStores.push(store);
        return enterStore(store.id, store.name);
      }).then(function () {
        toast(t('shopCreatedToast'));
        go('catalogue', null, { resetStack: true });
      }).catch(function () {
        S.nav.addStoreError = t('genericError');
        submitBtn.disabled = false; submitBtn.textContent = t('createAccountBtn');
        render();
      });
    };
    wrap.appendChild(f);
    return wrap;
  }

  function renderOwnerSignup() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:16px;padding-top:26px;"></div>');
    wrap.appendChild(el('<div><h2 class="subtitle">' + esc(t('shopSetupTitle')) + '</h2><p class="lede">' + esc(t('shopSetupSub')) + '</p></div>'));
    var f = el('<form style="display:flex;flex-direction:column;gap:14px;"></form>');
    f.appendChild(fieldTemplate(t('shopNameLabel'), 'text', 'shopName', t('shopNamePh')));
    f.appendChild(fieldTemplate(t('ownerPhoneLabel'), 'tel', 'ownerPhone', t('phonePh')));
    f.appendChild(fieldTemplate(t('setPinLabel'), 'password', 'ownerPin', t('pinPh'), '4'));
    f.appendChild(fieldTemplate(t('confirmPinLabel'), 'password', 'ownerPinConfirm', t('pinPh'), '4'));
    if (S.nav.signupError) f.appendChild(el('<div class="banner banner-danger">⚠ ' + esc(S.nav.signupError) + '</div>'));
    var submitBtn = el('<button type="submit" class="btn btn-grad btn-block">' + esc(t('createAccountBtn')) + '</button>');
    f.appendChild(submitBtn);
    var back = el('<button type="button" class="btn btn-ghost btn-block">' + esc(t('backBtn')) + '</button>');
    back.onclick = function () { go('welcome'); };
    f.appendChild(back);
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var name = f.shopName.value.trim(), phone = normalizePhone(f.ownerPhone.value);
      var pin = f.ownerPin.value.trim(), pin2 = f.ownerPinConfirm.value.trim();
      if (!name || !phone) { S.nav.signupError = t('signupErrFill'); render(); return; }
      var phoneErr = validatePhone(phone);
      if (phoneErr) { S.nav.signupError = t(phoneErrorKey(phoneErr)); render(); return; }
      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { S.nav.signupError = t('signupErrPinLen'); render(); return; }
      if (pin !== pin2) { S.nav.signupError = t('signupErrPinMatch'); render(); return; }
      submitBtn.disabled = true; submitBtn.textContent = t('savingText');
      api.signupOwner(phone, pin, name).then(function (res) {
        S.ownerId = res.owner_id;
        S.ownerStores = [{ id: res.store_id, name: res.store_name }];
        saveSession(S.ownerId);
        return enterStore(res.store_id, res.store_name);
      }).then(function () {
        toast(t('shopCreatedToast'));
        go('catalogue', null, { resetStack: true });
      }).catch(function (err) {
        S.nav.signupError = err && err.code === 'PHONE_TAKEN' ? t('signupErrPhoneTaken') : t('genericError');
        submitBtn.disabled = false; submitBtn.textContent = t('createAccountBtn');
        render();
      });
    };
    wrap.appendChild(f);
    return wrap;
  }

  function renderLogin() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:16px;padding-top:26px;"></div>');
    var change = el('<button type="button" class="gallery-link">' + esc(t('backBtn')) + '</button>');
    change.onclick = function () { go('welcome'); };
    wrap.appendChild(change);
    wrap.appendChild(el('<div style="text-align:center;font-size:36px;">🏪</div>'));
    wrap.appendChild(el('<h2 class="subtitle" style="text-align:center;">Hamari Dukaan</h2>'));
    wrap.appendChild(el('<div class="entry-badge">' + esc(t('ownerEntryBadge')) + '</div>'));
    wrap.appendChild(el('<p class="lede" style="text-align:center;">' + esc(t('loginOnceNote')) + '</p>'));
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
      api.loginOwner(phone, pin).then(function (result) {
        if (!result) {
          S.nav.loginError = t('loginError');
          submitBtn.disabled = false; submitBtn.textContent = t('loginBtn');
          render();
          return;
        }
        S.ownerId = result.owner_id;
        saveSession(S.ownerId);
        return api.listOwnerStores(S.ownerId).then(function (stores) {
          S.ownerStores = stores;
          toast(t('welcomeBackToast'));
          if (stores.length === 1) {
            return enterStore(stores[0].id, stores[0].name).then(function () { go('catalogue', null, { resetStack: true }); });
          }
          go('storeSelect', null, { resetStack: true });
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

  // ----- catalogue -----
  var debouncedRender = C.debounce(function () {
    render();
    var again = document.getElementById('searchInput');
    if (again) { again.focus(); again.selectionStart = again.selectionEnd = again.value.length; }
  }, 120);

  function renderCatalogue() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:10px;"></div>');
    wrap.appendChild(searchBar());
    var q = S.nav.query;

    var addLabel = q ? t('addNewWithQuery', q) : t('addNewPinned');
    var pinned = el('<div class="pinned-add"><span class="plus">+</span> ' + esc(addLabel) + '</div>');
    pinned.onclick = function () { openItem(null, 'catalogue', q); };
    wrap.appendChild(pinned);

    var results = filteredSkus(q);
    if (!S.skus.length) {
      wrap.appendChild(el('<div class="empty-state"><div class="big">🗂️</div><div>' + esc(t('emptyCatalogueOwner')) + '</div></div>'));
    } else if (!results.length) {
      wrap.appendChild(el('<div class="empty-state">' + esc(t('noMatch', q)) + '</div>'));
    } else {
      if (q) wrap.appendChild(el('<div class="list-caption">' + esc(t('existingMatches')) + '</div>'));
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

  function searchBar() {
    var wrap = el('<div class="search-wrap"><span class="search-icon">🔍</span><input class="input" placeholder="' + esc(t('searchPh')) + '" id="searchInput"></div>');
    var inp = wrap.querySelector('#searchInput');
    inp.value = S.nav.query;
    inp.oninput = function () {
      S.nav.query = inp.value; S.nav.page = 1; S.nav.receivePage = 1;
      debouncedRender();
    };
    return wrap;
  }

  function skuCard(s) {
    var card = el(
      '<div class="sku-card">' +
        '<img class="sku-photo" src="' + (s.photo || placeholderPhoto()) + '">' +
        '<div class="sku-body"><div class="sku-name">' + esc(s.name) + '</div><div class="sku-price">' + money(s.sell) + '</div></div>' +
      '</div>'
    );
    card.onclick = function () { openItem(s.id, 'catalogue'); };
    return card;
  }

  // ----- receive stock -----
  function renderReceiveStock() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:10px;"></div>');
    wrap.appendChild(el('<div><h2 class="subtitle" style="margin-bottom:4px;">' + esc(t('tabReceive')) + '</h2><p class="lede">' + esc(t('receiveSub')) + '</p></div>'));
    if (S.nav.receivedCount > 0) {
      wrap.appendChild(el('<div class="receive-chip">✓ ' + esc(t('receivedChip', S.nav.receivedCount)) + '</div>'));
    }
    wrap.appendChild(searchBar());
    var q = S.nav.query;
    var addLabel = q ? t('addNewWithQuery', q) : t('addNewPinned');
    var pinned = el('<div class="pinned-add"><span class="plus">+</span> ' + esc(addLabel) + '</div>');
    pinned.onclick = function () { openItem(null, 'receive', q); };
    wrap.appendChild(pinned);

    var results = filteredSkus(q);
    if (results.length) {
      wrap.appendChild(el('<div class="list-caption">' + esc(q ? t('tapToUpdate') : t('pickFromCatalogue')) + '</div>'));
      var pg = paginate(results, S.nav.receivePage, ROW_PAGE_SIZE);
      pg.pageItems.forEach(function (s) {
        var row = el(
          '<div class="list-row"><img class="thumb" src="' + (s.photo || placeholderPhoto()) + '">' +
          '<div class="info"><div class="name">' + esc(s.name) + '</div><div class="sub">' + qtyLabel(s.qty, s.unit) + ' · ' + money(s.cost) + '</div></div>' +
          '<div class="chev">›</div></div>'
        );
        row.onclick = function () { openItem(s.id, 'receive'); };
        wrap.appendChild(row);
      });
      wrap.appendChild(pagerRow(pg.page, pg.totalPages,
        function () { S.nav.receivePage--; render(); },
        function () { S.nav.receivePage++; render(); }, t));
    }

    var done = el('<button class="btn btn-ghost btn-block">' + esc(t('doneBack')) + '</button>');
    done.style.marginTop = '4px';
    done.onclick = function () { go('catalogue'); };
    wrap.appendChild(done);
    return wrap;
  }

  // ----- workers -----
  function renderWorkers() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:10px;"></div>');
    wrap.appendChild(el('<div><h2 class="subtitle" style="margin-bottom:4px;">' + esc(t('tabWorkers')) + '</h2><p class="lede">' + esc(t('workersSub')) + '</p></div>'));
    var addBtn = el('<button class="btn btn-grad btn-block">' + esc(t('addWorkerBtn')) + '</button>');
    addBtn.onclick = function () { openWorker(null); };
    wrap.appendChild(addBtn);
    if (!S.workers.length) {
      wrap.appendChild(el('<div class="empty-state"><div class="big">👤</div><div>' + esc(t('noWorkersYet')) + '</div></div>'));
    } else {
      S.workers.forEach(function (w) {
        var row = el(
          '<div class="worker-row"><div class="avatar">' + esc(w.name.charAt(0).toUpperCase()) + '</div>' +
          '<div class="info"><div class="name">' + esc(w.name) + '</div><div class="sub">' + esc(w.phone) + ' · PIN ' + esc(w.pin) + '</div></div>' +
          '<div class="chev">›</div></div>'
        );
        row.onclick = function () { openWorker(w.id); };
        wrap.appendChild(row);
      });
    }
    return wrap;
  }

  function openWorker(id) { go('workerEdit', { editingWorkerId: id }); }

  function renderWorkerEdit() {
    var w = S.nav.editingWorkerId ? findWorker(S.nav.editingWorkerId) : null;
    var isNew = !w;
    original = w ? { name: w.name, phone: w.phone, pin: w.pin } : { name: '', phone: '', pin: '' };
    var wrap = el('<div style="display:flex;flex-direction:column;gap:16px;"></div>');
    wrap.appendChild(el('<h2 class="subtitle">' + esc(isNew ? t('addWorkerHeading') : t('editWorkerHeading')) + '</h2>'));

    var nameF = fieldTemplate(t('workerNameLabel'), 'text', 'wname', t('workerNamePh'));
    var nameInp = nameF.querySelector('input'); nameInp.value = original.name;
    var phoneF = fieldTemplate(t('workerPhoneLabel'), 'tel', 'wphone', t('phonePh'));
    var phoneInp = phoneF.querySelector('input'); phoneInp.value = original.phone;
    var pinF = fieldTemplate(t('setPinLabel'), 'text', 'wpin', t('pinPh'), '4');
    var pinInp = pinF.querySelector('input'); pinInp.value = original.pin; pinInp.setAttribute('inputmode', 'numeric');

    var errBox = el('<div class="banner banner-danger" style="display:none;"></div>');
    var hintBox = el('<div class="banner banner-neutral">💡 ' + esc(t('workerLoginLinkHint')) + '</div>');

    var wrap2 = el('<div style="display:flex;flex-direction:column;gap:14px;"></div>');
    wrap2.appendChild(nameF); wrap2.appendChild(phoneF); wrap2.appendChild(pinF); wrap2.appendChild(hintBox); wrap2.appendChild(errBox);

    var actions = el('<div class="btn-row"></div>');
    var saveBtn = el('<button class="btn btn-primary">' + esc(t('saveWorkerBtn')) + '</button>');
    var cancelBtn = el('<button class="btn btn-ghost">' + esc(t('cancelBtn')) + '</button>');
    var backBtn = el('<button class="btn btn-outline">' + esc(t('backBtn')) + '</button>');
    actions.appendChild(saveBtn); actions.appendChild(cancelBtn); actions.appendChild(backBtn);

    saveBtn.onclick = function () {
      var name = nameInp.value.trim(), phone = normalizePhone(phoneInp.value), pin = pinInp.value.trim();
      if (!name || !phone) { errBox.textContent = '⚠ ' + t('workerErrFill'); errBox.style.display = 'flex'; return; }
      var phoneErr = validatePhone(phone);
      if (phoneErr) { errBox.textContent = '⚠ ' + t(phoneErrorKey(phoneErr)); errBox.style.display = 'flex'; return; }
      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { errBox.textContent = '⚠ ' + t('workerErrPin'); errBox.style.display = 'flex'; return; }
      saveBtn.disabled = true; saveBtn.textContent = t('savingText');
      var call = isNew ? api.addWorker(S.storeId, name, phone, pin) : api.updateWorker(w.id, name, phone, pin);
      call.then(function () {
        return loadStoreData().then(function () {
          toast(isNew ? t('workerAddedToast') : t('workerSavedToast'));
          go('workers');
        });
      }).catch(function (err) {
        saveBtn.disabled = false; saveBtn.textContent = t('saveWorkerBtn');
        errBox.textContent = '⚠ ' + (err && err.code === 'PHONE_TAKEN' ? t('workerErrPhoneTaken') : t('genericError'));
        errBox.style.display = 'flex';
      });
    };
    cancelBtn.onclick = function () {
      nameInp.value = original.name; phoneInp.value = original.phone; pinInp.value = original.pin;
      errBox.style.display = 'none';
    };
    backBtn.onclick = function () { go('workers'); };

    wrap.appendChild(wrap2);
    wrap.appendChild(actions);
    return wrap;
  }

  // ----- add / edit / view item (unified, owner) -----
  function openItem(id, context, prefillName) {
    var s = id ? findSku(id) : null;
    pendingPhoto = s ? s.photo : null;
    original = s ? { name: s.name, description: s.description, unit: s.unit, qty: s.qty, cost: s.cost, sell: s.sell, photo: s.photo }
                 : { name: prefillName || '', description: '', unit: 'piece', qty: '', cost: '', sell: '', photo: null };
    go('item', { editingId: id || null, context: context, prefillName: prefillName || '' });
  }

  function renderItem() {
    var s = S.nav.editingId ? findSku(S.nav.editingId) : null;
    var isReceive = S.nav.context === 'receive';
    var isNew = !s;
    var wrap = el('<div style="display:flex;flex-direction:column;gap:14px;"></div>');

    // photo (camera-primary) + name — matched-size boxes side by side
    var photoRow = el('<div class="item-photo-row"></div>');
    var photoTile = el('<div class="photo-tile" id="photoTile">' +
      (pendingPhoto ? '<img src="' + pendingPhoto + '"><span class="retake">' + esc(t('retakeLabel')) + '</span>' :
       '<div class="camicon">📷</div><div>' + esc(t('emptyPhotoAlt')) + '</div>') +
      '</div>');
    var cameraInput = el('<input type="file" accept="image/*" capture="environment" style="display:none;">');
    var galleryInput = el('<input type="file" accept="image/*" style="display:none;">');
    function handlePhotoFile(ev) {
      var file = ev.target.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        pendingPhoto = e.target.result;
        document.getElementById('photoTile').innerHTML = '<img src="' + pendingPhoto + '"><span class="retake">' + esc(t('retakeLabel')) + '</span>';
      };
      reader.readAsDataURL(file);
    }
    cameraInput.onchange = handlePhotoFile;
    galleryInput.onchange = handlePhotoFile;
    photoTile.onclick = function () { cameraInput.click(); };
    photoRow.appendChild(photoTile);
    photoRow.appendChild(cameraInput);
    photoRow.appendChild(galleryInput);

    var nameBox = el('<div class="item-name-box"></div>');
    nameBox.appendChild(el('<label class="item-name-label">' + esc(t('productNameLabel')) + '</label>'));
    var nameInput = el('<input class="item-name-input" placeholder="' + esc(t('productNamePh')) + '">');
    nameInput.value = s ? s.name : (S.nav.prefillName || '');
    nameBox.appendChild(nameInput);
    photoRow.appendChild(nameBox);
    wrap.appendChild(photoRow);

    var galleryLink = el('<button type="button" class="gallery-link">' + esc(t('chooseFromGallery')) + '</button>');
    galleryLink.onclick = function () { galleryInput.click(); };
    wrap.appendChild(galleryLink);

    // history on top (existing items only) — collapsible, latest first, max 3
    if (!isNew) {
      var histExpanded = true;
      var histBlock = el('<div class="history-block"></div>');
      var histHeader = el('<div class="history-header"><div class="list-caption" style="margin-top:0;">' + esc(t('historyHeading')) + '</div><span class="chev">▾</span></div>');
      var histRowsWrap = el('<div style="display:flex;flex-direction:column;gap:8px;"></div>');
      var hist = s.history.slice(0, 3);
      if (!hist.length) {
        histRowsWrap.appendChild(el('<div style="font-size:13px;color:var(--ink-muted);">' + esc(t('noHistory')) + '</div>'));
      } else {
        hist.forEach(function (h) {
          histRowsWrap.appendChild(el(
            '<div class="history-row"><div class="when">' + fmtWhen(h.when) + (h.supplier ? ' · ' + esc(h.supplier) : '') + '</div>' +
            '<div class="history-grid">' +
              '<div class="cell"><div class="k">' + esc(t('qtyLabel')) + '</div><div class="v">' + qtyLabel(h.qty, s.unit) + '</div></div>' +
              '<div class="cell"><div class="k">' + esc(t('costLabel')) + '</div><div class="v">' + money(h.cost) + '</div></div>' +
              '<div class="cell"><div class="k">' + esc(t('sellLabel')) + '</div><div class="v">' + money(h.sell) + '</div></div>' +
            '</div></div>'
          ));
        });
      }
      histHeader.onclick = function () {
        histExpanded = !histExpanded;
        histRowsWrap.style.display = histExpanded ? 'flex' : 'none';
        histHeader.querySelector('.chev').style.transform = histExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
      };
      histBlock.appendChild(histHeader);
      histBlock.appendChild(histRowsWrap);
      wrap.appendChild(histBlock);
    }

    // description
    var descWrap = el('<div class="field"><label class="label">' + esc(t('descLabel')) + '</label></div>');
    var descArea = el('<textarea class="textarea" maxlength="300" placeholder="' + esc(t('descPh')) + '"></textarea>');
    descArea.value = s ? s.description : '';
    var counter = el('<div class="counter">0/300</div>');
    function updateCounter() { var n = descArea.value.length; counter.textContent = n + '/300'; counter.classList.toggle('near-limit', n > 270); }
    updateCounter();
    descArea.oninput = updateCounter;
    descWrap.appendChild(descArea); descWrap.appendChild(counter);
    wrap.appendChild(descWrap);

    // unit + qty
    var row1 = el('<div class="row-2"></div>');
    var unitF = el('<div class="field"><label class="label">' + esc(t('unitLabel')) + '</label></div>');
    var unitSel = el(
      '<select class="select"><option value="piece">Piece</option><option value="kg">Kilogram (kg)</option>' +
      '<option value="gram">Gram (g)</option><option value="litre">Litre (L)</option>' +
      '<option value="dozen">Dozen</option><option value="packet">Packet</option></select>'
    );
    unitSel.value = s ? s.unit : 'piece';
    unitF.appendChild(unitSel);
    var qtyF = el('<div class="field"><label class="label">' + esc(isReceive ? t('qtyNowLabel') : t('qtyLabel')) + '</label></div>');
    var qtyInp = el('<input class="input" type="number" step="0.01" min="0" placeholder="0">');
    qtyInp.value = s ? s.qty : '';
    qtyF.appendChild(qtyInp);
    row1.appendChild(unitF); row1.appendChild(qtyF);
    wrap.appendChild(row1);

    // cost + sell
    var row2 = el('<div class="row-2"></div>');
    var costF = el('<div class="field"><label class="label">' + esc(t('costLabel')) + '</label></div>');
    var costInp = el('<input class="input" type="number" step="0.01" min="0" placeholder="₹">');
    costInp.value = s ? s.cost : '';
    costF.appendChild(costInp);
    var sellF = el('<div class="field"><label class="label">' + esc(t('sellLabel')) + '</label></div>');
    var sellInp = el('<input class="input" type="number" step="0.01" min="0" placeholder="₹">');
    sellInp.value = s ? s.sell : '';
    sellF.appendChild(sellInp);
    row2.appendChild(costF); row2.appendChild(sellF);
    wrap.appendChild(row2);
    [qtyInp, costInp, sellInp].forEach(disableWheelChange);

    var marginWarn = el('<div class="banner banner-danger" style="display:none;">⚠ ' + esc(t('marginWarn')) + '</div>');
    wrap.appendChild(marginWarn);
    function checkMargin() {
      var c = parseFloat(costInp.value), sl = parseFloat(sellInp.value);
      marginWarn.style.display = (!isNaN(c) && !isNaN(sl) && sl <= c) ? 'flex' : 'none';
    }
    costInp.oninput = checkMargin; sellInp.oninput = checkMargin;
    checkMargin();

    // margin stat (existing items)
    if (!isNew) {
      var margin = s.sell - s.cost;
      var marginPct = s.cost ? Math.round((margin / s.cost) * 100) : 0;
      wrap.appendChild(el(
        '<div class="stat-row">' +
          '<div class="stat-box"><div class="k">' + esc(t('quantityStat')) + '</div><div class="v">' + qtyLabel(s.qty, s.unit) + '</div></div>' +
          '<div class="stat-box"><div class="k">' + esc(t('marginStat')) + '</div><div class="v">' + money(margin) +
            '<div class="margin-chip ' + (margin > 0 ? 'good' : 'bad') + '">' + (margin > 0 ? esc(t('marginPct', marginPct)) : esc(t('marginBad'))) + '</div></div></div>' +
        '</div>'
      ));
    }

    // supplier (receive)
    var supplierInp = null;
    if (isReceive) {
      var supF = fieldTemplate(t('supplierLabel'), 'text', 'supplier', t('supplierPh'));
      supplierInp = supF.querySelector('input');
      supplierInp.value = s && s.lastSupplier ? s.lastSupplier : '';
      wrap.appendChild(supF);
    }

    var formErr = el('<div class="banner banner-danger" style="display:none;"></div>');
    wrap.appendChild(formErr);

    // actions: Save / Cancel / Back
    var actions = el('<div class="btn-row"></div>');
    var saveBtn = el('<button class="btn btn-primary">' + esc(isReceive ? t('saveUpdateStockBtn') : t('saveBtn')) + '</button>');
    var cancelBtn = el('<button class="btn btn-ghost">' + esc(t('cancelBtn')) + '</button>');
    var backBtn = el('<button class="btn btn-outline">' + esc(t('backBtn')) + '</button>');
    actions.appendChild(saveBtn); actions.appendChild(cancelBtn); actions.appendChild(backBtn);
    wrap.appendChild(actions);

    cancelBtn.onclick = function () {
      nameInput.value = original.name;
      descArea.value = original.description; updateCounter();
      unitSel.value = original.unit;
      qtyInp.value = original.qty;
      costInp.value = original.cost;
      sellInp.value = original.sell;
      pendingPhoto = original.photo;
      document.getElementById('photoTile').innerHTML = pendingPhoto ?
        '<img src="' + pendingPhoto + '"><span class="retake">' + esc(t('retakeLabel')) + '</span>' :
        '<div class="camicon">📷</div><div>' + esc(t('emptyPhotoAlt')) + '</div>';
      checkMargin();
      formErr.style.display = 'none';
    };
    backBtn.onclick = function () { go(isReceive ? 'receiveStock' : 'catalogue'); };

    saveBtn.onclick = function () {
      var name = nameInput.value.trim();
      var qty = parseFloat(qtyInp.value), cost = parseFloat(costInp.value), sell = parseFloat(sellInp.value);
      if (!name) { formErr.textContent = '⚠ ' + t('nameRequired'); formErr.style.display = 'flex'; return; }
      if (isNaN(qty) || isNaN(cost) || isNaN(sell)) { formErr.textContent = '⚠ ' + t('fieldsRequired'); formErr.style.display = 'flex'; return; }
      var now = new Date();
      var supplierVal = supplierInp ? supplierInp.value.trim() : '';
      var histEntry = { when: now, qty: qty, cost: cost, sell: sell, supplier: supplierVal };
      var newHistory = [histEntry].concat(isNew ? [] : s.history);
      var fields = { name: name, description: descArea.value.trim(), photo: pendingPhoto || (s ? s.photo : placeholderPhoto()),
        unit: unitSel.value, qty: qty, cost: cost, sell: sell, lastSupplier: supplierVal || (s ? s.lastSupplier : ''), history: newHistory };

      // Existing-item saves resolve immediately (see api.updateSku) so this
      // feels instant even on a slow connection — new items still need a
      // real round trip since they need a server-generated id.
      if (!isNew) {
        var call = api.updateSku(s.id, fields);
        Object.assign(s, fields); // update local state right away, don't wait
        if (isReceive) {
          S.nav.receivedCount++;
          toast(t('updatedToast', S.nav.receivedCount));
          S.nav.query = '';
          go('receiveStock');
        } else {
          toast(t('savedToast'));
          go('catalogue');
        }
        call.then(function (saved) { Object.assign(s, saved); render(); }).catch(function () {});
        return;
      }

      saveBtn.disabled = true; cancelBtn.disabled = true; backBtn.disabled = true;
      saveBtn.textContent = t('savingText');
      api.insertSku(S.storeId, fields).then(function (saved) {
        S.skus.push(saved);
        if (isReceive) {
          S.nav.receivedCount++;
          toast(t('updatedToast', S.nav.receivedCount));
          S.nav.query = '';
          go('receiveStock');
        } else {
          toast(t('addedToast'));
          go('catalogue');
        }
      }).catch(function () {
        formErr.textContent = '⚠ ' + t('genericError');
        formErr.style.display = 'flex';
        saveBtn.disabled = false; cancelBtn.disabled = false; backBtn.disabled = false;
        saveBtn.textContent = esc(isReceive ? t('saveUpdateStockBtn') : t('saveBtn'));
      });
    };

    return wrap;
  }

  C.initOfflineBanner(t);
  C.initUpdateBanner(t);
  C.initBackNav(handleBack);
  boot();
})();
