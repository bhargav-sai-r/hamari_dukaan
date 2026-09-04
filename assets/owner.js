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
      validatePhone = C.validatePhone, phoneErrorKey = C.phoneErrorKey,
      compressImage = C.compressImage, showModal = C.showModal, showActionSheet = C.showActionSheet, closeOverlay = C.closeOverlay;

  // ---------------- state ----------------
  function blank() {
    return {
      lang: 'en',
      ownerId: null, storeId: null, storeName: null, ownerStores: [], workers: [], skus: [], session: null,
      nav: { query: '', page: 1, receivePage: 1, editingId: null, context: 'catalogue', prefillName: '',
             receivedCount: 0, loginError: '', signupError: '', addStoreError: '', menuOpen: false,
             editingWorkerId: null, busy: false,
             // Bikri tab: which products currently have an un-submitted
             // quantity typed in ({ [skuId]: { qty: '2', touchedAt: N } }),
             // and a simple incrementing counter used to sort "Sales
             // Noted" by whichever was touched most recently. Lives here
             // (not a local variable) so it survives switching tabs away
             // from Bikri and back, same as everything else in S.nav.
             bikriPending: {}, bikriTouchSeq: 0 }
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
  var itemFooterEl = null; // the item screen's fixed Save/Close bar — built inside renderItem(), appended by render()

  function filteredSkus(q) {
    var scored = S.skus.map(function (s) { return { s: s, score: matchScore(q, s.name + ' ' + s.description) }; });
    scored = scored.filter(function (x) { return x.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score || a.s.name.localeCompare(b.s.name); });
    return scored.map(function (x) { return x.s; });
  }
  // Older cached/demo rows may not have an `active` field at all (from
  // before this column existed) — treat "not exactly false" as active, so
  // nothing already in a browser's storage gets silently hidden.
  function isActiveSku(s) { return s.active !== false; }
  function findSku(id) { return S.skus.filter(function (s) { return s.id === id; })[0]; }
  function findWorker(id) { return S.workers.filter(function (w) { return w.id === id; })[0]; }

  // Units that are only ever counted in whole numbers — "2.5 piece" or
  // "1.5 dozen" doesn't mean anything, unlike "1.5 kg" or "0.5 litre"
  // which are perfectly normal (round 4.10). Shared by both the item
  // screen's Total Qty/Rec. Qty validation and the Bikri tab's sold-qty
  // validation, so the rule can't drift between the two.
  var WHOLE_UNITS = { piece: true, dozen: true, packet: true };
  function isWholeUnit(u) { return !!WHOLE_UNITS[u]; }
  var WHOLE_UNIT_LABEL = { piece: 'Piece', dozen: 'Dozen', packet: 'Packet' };

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
    if (chrome && S.session && (route === 'catalogue' || route === 'receiveStock' || route === 'bikri' || route === 'workers')) {
      app.appendChild(renderTabbar());
    }
    // Item screen has its own fixed Save/Close bar instead of the tabbar —
    // renderItem() (called above via renderRoute()) builds it and stashes
    // it in itemFooterEl so it can be appended after .main, same pattern
    // as the tabbar.
    if (chrome && route === 'item' && itemFooterEl) app.appendChild(itemFooterEl);
    if (window.HD_TOUR) window.HD_TOUR.onRender();
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
    if (window.HD_TOUR) {
      var tourBtn = el('<button class="icon-btn" title="' + esc(t('tourReplayLabel')) + '">❓</button>');
      tourBtn.onclick = function () { window.HD_TOUR.start(t); };
      bar.appendChild(tourBtn);
    }
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
      { key: 'bikri', ic: '🧾', lb: t('tabBikri') },
      { key: 'workers', ic: '👥', lb: t('tabWorkers') }
    ];
    var bar = el('<div class="tabbar"></div>');
    tabs.forEach(function (tb) {
      var active = route === tb.key;
      var te = el('<div class="tab ' + (active ? 'active' : '') + '" data-tour="tab-' + tb.key + '"><div class="ic">' + tb.ic + '</div><div class="lb">' + esc(tb.lb) + '</div></div>');
      te.onclick = function () {
        S.nav.query = ''; S.nav.page = 1; go(tb.key);
        if (window.HD_TOUR) window.HD_TOUR.signal('tab:' + tb.key);
      };
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
      case 'bikri': return renderBikri();
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
        // The interactive tour only ever offers to start here — right
        // after creating your very FIRST store, while Catalogue is still
        // empty. Adding a second/third store later (a returning, already
        // comfortable owner) never re-triggers it.
        if (window.HD_TOUR) window.HD_TOUR.maybeAutoStart(t);
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

    var allMatches = filteredSkus(q);
    var results = allMatches.filter(isActiveSku);
    // Removed items only ever resurface when the owner is actively
    // searching — never while just browsing the catalogue — and only
    // here in Catalogue (not Receive Stock, per the owner's choice).
    var archivedMatches = q ? allMatches.filter(function (s) { return !isActiveSku(s); }) : [];
    if (!S.skus.length) {
      wrap.appendChild(el('<div class="empty-state"><div class="big">🗂️</div><div>' + esc(t('emptyCatalogueOwner')) + '</div></div>'));
    } else if (!results.length && !archivedMatches.length) {
      // No active products to show. If this is a plain empty-quotes
      // situation (nothing searched, everything's been removed), give the
      // normal "add your first product" message instead of an odd-looking
      // "No products match \"\" yet." with no search term to point at.
      wrap.appendChild(q
        ? el('<div class="empty-state">' + esc(t('noMatch', q)) + '</div>')
        : el('<div class="empty-state"><div class="big">🗂️</div><div>' + esc(t('emptyCatalogueOwner')) + '</div></div>'));
    } else {
      if (results.length) {
        if (q) wrap.appendChild(el('<div class="list-caption">' + esc(t('existingMatches')) + '</div>'));
        var pg = paginate(results, S.nav.page, PAGE_SIZE);
        var grid = el('<div class="card-grid"></div>');
        pg.pageItems.forEach(function (s) { grid.appendChild(skuCard(s)); });
        wrap.appendChild(grid);
        wrap.appendChild(pagerRow(pg.page, pg.totalPages,
          function () { S.nav.page--; render(); },
          function () { S.nav.page++; render(); }, t));
      }
      if (archivedMatches.length) {
        wrap.appendChild(el('<div class="list-caption removed-caption">' + esc(t('removedProductsHeading')) + '</div>'));
        archivedMatches.forEach(function (s) { wrap.appendChild(archivedRow(s)); });
      }
    }
    return wrap;
  }

  function searchBar() {
    var wrap = el('<div class="search-wrap"><span class="search-icon">🔍</span><input class="input" placeholder="' + esc(t('searchPh')) + '" id="searchInput"></div>');
    var inp = wrap.querySelector('#searchInput');
    inp.value = S.nav.query;
    if (S.nav.query) {
      var clearBtn = el('<button type="button" class="search-clear" aria-label="' + esc(t('cancelBtn')) + '">✕</button>');
      clearBtn.onclick = function () {
        S.nav.query = ''; S.nav.page = 1; S.nav.receivePage = 1;
        render();
        var again = document.getElementById('searchInput');
        if (again) again.focus();
      };
      wrap.appendChild(clearBtn);
    }
    inp.oninput = function () {
      S.nav.query = inp.value; S.nav.page = 1; S.nav.receivePage = 1;
      debouncedRender();
    };
    return wrap;
  }

  function skuCard(s) {
    var card = el(
      '<div class="sku-card" data-tour-sku="' + s.id + '">' +
        '<img class="sku-photo" src="' + (s.photo || placeholderPhoto()) + '">' +
        '<div class="sku-body"><div class="sku-name">' + esc(s.name) + '</div><div class="sku-price">' + money(s.sell) + '</div></div>' +
      '</div>'
    );
    card.onclick = function () { openItem(s.id, 'catalogue'); };
    return card;
  }

  // A removed product surfaced in a Catalogue search — tapping it offers
  // to bring it back, rather than opening the item screen like a normal
  // match would.
  function archivedRow(s) {
    var row = el(
      '<div class="list-row removed-row"><img class="thumb" src="' + (s.photo || placeholderPhoto()) + '">' +
      '<div class="info"><div class="name">' + esc(s.name) + '</div><div class="sub removed-caption">' + esc(t('removedBadge')) + '</div></div>' +
      '<div class="chev">›</div></div>'
    );
    row.onclick = function () { reactivateSku(s); };
    return row;
  }

  function reactivateSku(s) {
    showConfirm({
      title: t('reactivateConfirmTitle'), body: t('reactivateConfirmBody'),
      confirmLabel: t('reactivateConfirmYes'), cancelLabel: t('cancelBtn'),
      onConfirm: function () {
        api.setSkuActive(s.id, true).then(function () {
          s.active = true;
          toast(t('reactivatedToast'));
          render();
        });
      }
    });
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

    // Removed products never show here at all — not even via search —
    // since bringing one back is a Catalogue-only action.
    var results = filteredSkus(q).filter(isActiveSku);
    if (results.length) {
      wrap.appendChild(el('<div class="list-caption">' + esc(q ? t('tapToUpdate') : t('pickFromCatalogue')) + '</div>'));
      var pg = paginate(results, S.nav.receivePage, ROW_PAGE_SIZE);
      pg.pageItems.forEach(function (s) {
        var row = el(
          '<div class="list-row" data-tour-sku="' + s.id + '"><img class="thumb" src="' + (s.photo || placeholderPhoto()) + '">' +
          '<div class="info"><div class="name">' + esc(s.name) + '</div><div class="sub' + (s.qty <= 0 ? ' qty-negative' : '') + '">' + qtyLabel(s.qty, s.unit) + ' · ' + money(s.cost) + '</div></div>' +
          '<div class="chev">›</div></div>'
        );
        row.onclick = function () {
          openItem(s.id, 'receive');
          if (window.HD_TOUR) window.HD_TOUR.signal('receive:open-tracked-row', { id: s.id });
        };
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

  // ----- bikri (sale recording) -----
  // Owner-only reconciliation tool: search (or just scroll) to a product,
  // type how many sold, tap OK, then submit the whole batch at once. See
  // the round 4.9/4.10 design notes in the project doc for the full
  // reasoning; the short version —
  //   - "Sales Noted" holds every product with a committed (OK-confirmed)
  //     quantity, newest-touched first, and survives clearing/changing the
  //     search box. "All Products" holds everything else, filtered by
  //     search.
  //   - Typing updates a live ₹ preview immediately (no re-render, so the
  //     keyboard/cursor is never disturbed) but commits nothing — only
  //     tapping OK commits the value, and it does so unconditionally by
  //     calling render() straight away (round 4.10), which is what makes
  //     the row jump into "Sales Noted" the instant it's confirmed,
  //     whether this row was reached by scrolling or by searching. This
  //     is safe specifically because it's the OK button's OWN click that
  //     triggers the render — earlier this committed on blur instead,
  //     which had to avoid calling render() directly since a blur firing
  //     as a side effect of tapping a DIFFERENT button could rebuild the
  //     DOM out from under that other button before its own click fired.
  //     An explicit confirm button has no such race to avoid.
  //   - Record Sales and Cancel both re-read S.nav.bikriPending fresh at
  //     the moment they're tapped — never a stale list captured back when
  //     the screen was last drawn.
  function currentBikriLines() {
    return Object.keys(S.nav.bikriPending)
      .map(function (idStr) { return { id: Number(idStr), entry: S.nav.bikriPending[idStr] }; })
      .filter(function (x) { return x.entry && parseFloat(x.entry.qty) > 0; })
      .sort(function (a, b) { return b.entry.touchedAt - a.entry.touchedAt; })
      .map(function (x) {
        var sku = findSku(x.id);
        if (!sku) return null;
        var qty = parseFloat(x.entry.qty);
        return { id: sku.id, name: sku.name, unit: sku.unit, qty: qty, sellPrice: sku.sell, amount: qty * sku.sell, currentQty: Number(sku.qty) || 0 };
      })
      .filter(Boolean);
  }

  function bikriConfirmPopup(opts) {
    var root = document.getElementById('overlayRoot');
    if (!root) return;
    var dlg = el(
      '<div class="overlay"><div class="dialog">' +
        '<h3>' + esc(opts.title) + '</h3>' +
        '<div class="modal-body">' + opts.bodyHtml + '</div>' +
        '<div class="btn-row">' +
          '<button class="btn btn-ghost" id="bkBack">' + esc(opts.cancelLabel) + '</button>' +
          '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" id="bkConfirm">' + esc(opts.confirmLabel) + '</button>' +
        '</div>' +
      '</div></div>'
    );
    root.innerHTML = ''; root.appendChild(dlg);
    dlg.querySelector('#bkBack').onclick = closeOverlay;
    dlg.querySelector('#bkConfirm').onclick = function () { closeOverlay(); opts.onConfirm(); };
    dlg.onclick = function (e) { if (e.target === dlg) closeOverlay(); };
    if (window.HD_TOUR) window.HD_TOUR.onRender();
  }

  function bikriLinesSummaryHtml(lines) {
    var totalAmt = 0;
    var rowsHtml = lines.map(function (line) {
      totalAmt += line.amount;
      return '<div class="history-row"><div class="when">' + esc(line.name) + '</div>' +
        '<div class="history-grid" style="grid-template-columns:1fr 1fr;">' +
          '<div class="cell"><div class="k">' + esc(t('soldQtyPh')) + '</div><div class="v">' + qtyLabel(line.qty, line.unit) + '</div></div>' +
          '<div class="cell"><div class="k">' + esc(t('summaryTotalLabel')) + '</div><div class="v">' + money(line.amount) + '</div></div>' +
        '</div></div>';
    }).join('');
    var totalsHtml = '<div class="stat-row" style="margin-top:8px;">' +
      '<div class="stat-box"><div class="k">' + esc(t('summaryProductsLabel')) + '</div><div class="v">' + lines.length + '</div></div>' +
      '<div class="stat-box"><div class="k">' + esc(t('summaryTotalLabel')) + '</div><div class="v">' + money(totalAmt) + '</div></div>' +
    '</div>';
    return rowsHtml + totalsHtml;
  }

  function showTodaySales() {
    api.listSalesForToday(S.storeId).then(function (rows) {
      var bodyHtml;
      if (!rows.length) {
        bodyHtml = '<div style="font-size:13px;color:var(--ink-muted);">' + esc(t('noSalesToday')) + '</div>';
      } else {
        var totalAmt = 0, products = {};
        rows.forEach(function (r) { totalAmt += r.lineTotal; products[r.skuId] = true; });
        var rowsHtml = rows.map(function (r) {
          return '<div class="history-row"><div class="when">' + esc(r.skuName) + ' · ' + fmtWhen(r.recordedAt) + '</div>' +
            '<div class="history-grid" style="grid-template-columns:1fr 1fr;">' +
              '<div class="cell"><div class="k">' + esc(t('soldQtyPh')) + '</div><div class="v">' + qtyLabel(r.qty, r.unit) + '</div></div>' +
              '<div class="cell"><div class="k">' + esc(t('summaryTotalLabel')) + '</div><div class="v">' + money(r.lineTotal) + '</div></div>' +
            '</div></div>';
        }).join('');
        var totalsHtml = '<div class="stat-row" style="margin-top:8px;">' +
          '<div class="stat-box"><div class="k">' + esc(t('summaryProductsLabel')) + '</div><div class="v">' + Object.keys(products).length + '</div></div>' +
          '<div class="stat-box"><div class="k">' + esc(t('summaryTotalLabel')) + '</div><div class="v">' + money(totalAmt) + '</div></div>' +
        '</div>';
        bodyHtml = rowsHtml + totalsHtml;
      }
      showModal({ title: t('todaySalesHeading'), bodyHtml: bodyHtml, closeLabel: t('closeBtn') });
      if (window.HD_TOUR) window.HD_TOUR.signal('bikri:today-shown');
    });
  }

  // round 4.10: typing a number in a Bikri row no longer commits anything
  // by itself — tapping the OK button next to it is the one explicit
  // action that (a) validates the number, (b) commits it, (c) clears
  // whatever's in the search box, and (d) redraws the whole tab with
  // Sales Noted at the top. This replaces the earlier design, where the
  // entry only quietly committed on blur and only visually moved into
  // "Sales Noted" the next time something else happened to trigger a
  // re-render (e.g. a search) — that design existed specifically to
  // avoid calling render() from inside a blur handler, since a blur
  // firing as a side effect of tapping a DIFFERENT button risked
  // rebuilding the DOM out from under that other button before its own
  // click event had fired. Committing from the OK button's own click
  // handler sidesteps that risk entirely — there's no other element's
  // click in flight to race against, so it's safe to render() directly,
  // and doing so is what makes the "Sales Noted" section populate
  // immediately regardless of whether this row was reached by scrolling
  // or by searching, exactly as asked for.
  function bikriRow(s, inNotedSection) {
    var pending = S.nav.bikriPending[s.id];
    var row = el(
      '<div class="list-row bikri-row" data-tour-sku="' + s.id + '">' +
        '<img class="thumb" src="' + (s.photo || placeholderPhoto()) + '">' +
        '<div class="info">' +
          '<div class="name">' + esc(s.name) + '</div>' +
          '<div class="sub' + (s.qty <= 0 ? ' qty-negative' : '') + '">' + qtyLabel(s.qty, s.unit) + '</div>' +
          '<div class="bikri-amount" style="display:none;"></div>' +
          '<div class="bikri-err" style="display:none;"></div>' +
        '</div>' +
        '<input class="input bikri-qty-inp" type="number" step="0.01" min="0" inputmode="decimal" placeholder="' + esc(t('soldQtyPh')) + '">' +
        '<button type="button" class="bikri-ok-btn">' + esc(t('okBtn')) + '</button>' +
      '</div>'
    );
    var inp = row.querySelector('.bikri-qty-inp');
    var amountEl = row.querySelector('.bikri-amount');
    var errEl = row.querySelector('.bikri-err');
    var okBtn = row.querySelector('.bikri-ok-btn');
    var committedRaw = pending ? String(pending.qty) : '';
    inp.value = committedRaw;
    disableWheelChange(inp);
    // Whole-number-only units (piece/dozen/packet) get the numeric keypad
    // without a decimal key, same reasoning as the item screen's qty field.
    if (isWholeUnit(s.unit)) { inp.step = '1'; inp.setAttribute('inputmode', 'numeric'); }

    function updatePreview() {
      var v = parseFloat(inp.value);
      if (!isNaN(v) && v > 0) {
        amountEl.style.display = 'block';
        amountEl.textContent = qtyLabel(v, s.unit) + ' × ' + money(s.sell) + ' = ' + money(v * s.sell);
      } else {
        amountEl.style.display = 'none';
      }
    }
    function refreshOkState() { okBtn.disabled = (inp.value.trim() === committedRaw); }
    updatePreview();
    refreshOkState();

    // Live preview only — deliberately NOT a render() call, so typing
    // never fights the keyboard/cursor.
    inp.oninput = function () {
      updatePreview();
      errEl.style.display = 'none';
      refreshOkState();
    };
    okBtn.onclick = function () {
      var raw = inp.value.trim();
      var v = parseFloat(raw);
      if (raw === '' || isNaN(v) || v <= 0) {
        // Blank/zero + OK un-notes the row (puts it back under "All
        // Products") — the symmetric counterpart to committing a value.
        delete S.nav.bikriPending[s.id];
        S.nav.query = '';
        if (window.HD_TOUR) window.HD_TOUR.signal('bikri:qty-entered', { id: s.id });
        render();
        return;
      }
      if (isWholeUnit(s.unit) && v % 1 !== 0) {
        errEl.textContent = t('wholeUnitErr', WHOLE_UNIT_LABEL[s.unit]);
        errEl.style.display = 'block';
        return;
      }
      S.nav.bikriPending[s.id] = { qty: raw, touchedAt: ++S.nav.bikriTouchSeq };
      S.nav.query = '';
      if (window.HD_TOUR) window.HD_TOUR.signal('bikri:qty-entered', { id: s.id });
      render();
    };
    if (inNotedSection) row.classList.add('bikri-noted');
    return row;
  }

  function renderBikri() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:10px;"></div>');
    wrap.appendChild(el('<div><h2 class="subtitle" style="margin-bottom:4px;">' + esc(t('tabBikri')) + '</h2><p class="lede">' + esc(t('bikriSub')) + '</p></div>'));

    var todayBtn = el('<button type="button" class="btn btn-yellow btn-block" data-tour="today-sales-btn">' + esc(t('todaySalesBtn')) + '</button>');
    todayBtn.onclick = showTodaySales;
    wrap.appendChild(todayBtn);

    wrap.appendChild(searchBar());
    var q = S.nav.query;

    var notedIds = Object.keys(S.nav.bikriPending)
      .filter(function (idStr) { return S.nav.bikriPending[idStr] && parseFloat(S.nav.bikriPending[idStr].qty) > 0; })
      .sort(function (a, b) { return S.nav.bikriPending[b].touchedAt - S.nav.bikriPending[a].touchedAt; });

    if (notedIds.length) {
      wrap.appendChild(el('<div class="list-caption" data-tour="sales-noted-heading">' + esc(t('salesNotedHeading')) + '</div>'));
      notedIds.forEach(function (idStr) {
        var sku = findSku(Number(idStr));
        if (sku) wrap.appendChild(bikriRow(sku, true));
      });
    }

    var notedSet = {}; notedIds.forEach(function (idStr) { notedSet[idStr] = true; });
    var remaining = filteredSkus(q).filter(isActiveSku).filter(function (s) { return !notedSet[s.id]; });

    if (!S.skus.length) {
      wrap.appendChild(el('<div class="empty-state"><div class="big">🧾</div><div>' + esc(t('emptyCatalogueOwner')) + '</div></div>'));
    } else if (remaining.length) {
      wrap.appendChild(el('<div class="list-caption">' + esc(t('allProductsHeading')) + '</div>'));
      remaining.forEach(function (s) { wrap.appendChild(bikriRow(s, false)); });
    } else if (q && !notedIds.length) {
      wrap.appendChild(el('<div class="empty-state">' + esc(t('noMatch', q)) + '</div>'));
    }

    var actions = el('<div class="btn-row" data-tour="bikri-actions"></div>');
    var cancelBtn = el('<button type="button" class="btn btn-ghost" data-tour="bikri-cancel-btn">' + esc(t('cancelBtn')) + '</button>');
    var recordBtn = el('<button type="button" class="btn btn-primary" data-tour="record-sales-btn">' + esc(t('recordSalesBtn')) + '</button>');
    actions.appendChild(cancelBtn); actions.appendChild(recordBtn);
    wrap.appendChild(actions);

    cancelBtn.onclick = function () {
      var lines = currentBikriLines();
      if (!lines.length) { go('catalogue'); return; }
      bikriConfirmPopup({
        title: t('discardConfirmEntriesTitle'),
        bodyHtml: '<p style="margin:0 0 8px;font-size:13.5px;">' + esc(t('discardConfirmEntriesBody')) + '</p>' + bikriLinesSummaryHtml(lines),
        confirmLabel: t('discardEntriesYes'), cancelLabel: t('goBackBtn'), danger: true,
        onConfirm: function () { S.nav.bikriPending = {}; go('catalogue'); }
      });
    };

    recordBtn.onclick = function () {
      var lines = currentBikriLines();
      if (!lines.length) return; // nothing typed — quietly do nothing rather than record an empty batch
      bikriConfirmPopup({
        title: t('recordConfirmTitle'), bodyHtml: bikriLinesSummaryHtml(lines),
        confirmLabel: t('recordConfirmYes'), cancelLabel: t('goBackBtn'),
        onConfirm: function () {
          if (window.HD_TOUR) window.HD_TOUR.signal('bikri:confirmed');
          api.recordSales(S.storeId, lines).then(function (results) {
            // api.recordSales() computes each line's new qty exactly ONCE
            // (server-side for real mode, or in api.js's demo branch) and
            // hands it back here — we just assign it, never re-subtract.
            // (Re-subtracting a second time here was a real bug: in demo
            // mode S.skus and demoDb.skus are the SAME object references,
            // so subtracting in both places silently double-decremented
            // stock on every sale.)
            results.forEach(function (r) {
              var sku = findSku(r.id);
              if (sku) sku.qty = r.newQty;
            });
            S.nav.bikriPending = {};
            toast(t('salesRecordedToast', lines.length));
            render();
          }).catch(function () { toast(t('genericError')); });
        }
      });
    };

    return wrap;
  }

  // ----- workers -----
  function renderWorkers() {
    var wrap = el('<div style="display:flex;flex-direction:column;gap:10px;"></div>');
    wrap.appendChild(el('<div><h2 class="subtitle" style="margin-bottom:4px;">' + esc(t('tabWorkers')) + '</h2><p class="lede">' + esc(t('workersSub')) + '</p></div>'));
    var addBtn = el('<button class="btn btn-grad btn-block" data-tour="add-worker-btn">' + esc(t('addWorkerBtn')) + '</button>');
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
    var saveBtn = el('<button class="btn btn-primary" data-tour="worker-save-btn">' + esc(t('saveWorkerBtn')) + '</button>');
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
          if (isNew && window.HD_TOUR) window.HD_TOUR.signal('worker:added');
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
    var isReceiveCtx = context === 'receive';
    // Receive Stock is a FRESH entry for this batch, not an edit of the
    // last one — qty/cost/sell/mrp start blank here even for an existing
    // product, exactly like adding a brand-new product does. Opening the
    // very same product from Catalogue still pre-fills its current
    // values, unchanged from before.
    original = s
      ? {
          name: s.name, description: s.description, unit: s.unit,
          qty: isReceiveCtx ? '' : s.qty,
          cost: isReceiveCtx ? '' : s.cost,
          sell: isReceiveCtx ? '' : s.sell,
          mrp: isReceiveCtx ? '' : (s.mrp === null || s.mrp === undefined ? '' : s.mrp),
          photo: s.photo, supplier: s.lastSupplier || ''
        }
      : { name: prefillName || '', description: '', unit: 'piece', qty: '', cost: '', sell: '', mrp: '', photo: null, supplier: '' };
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
      // Resize + recompress to a JPEG before it ever becomes a stored data
      // URL — this is what keeps product photos from bloating the database.
      // Falls back to the original raw-file behaviour if compression fails
      // for any reason (unsupported format, canvas error, etc.) so a photo
      // can still always be added.
      compressImage(file, 800, 0.75).then(function (dataUrl) {
        pendingPhoto = dataUrl;
        document.getElementById('photoTile').innerHTML = '<img src="' + pendingPhoto + '"><span class="retake">' + esc(t('retakeLabel')) + '</span>';
        checkDirty();
      }).catch(function () {
        var reader = new FileReader();
        reader.onload = function (e) {
          pendingPhoto = e.target.result;
          document.getElementById('photoTile').innerHTML = '<img src="' + pendingPhoto + '"><span class="retake">' + esc(t('retakeLabel')) + '</span>';
          checkDirty();
        };
        reader.readAsDataURL(file);
      });
    }
    cameraInput.onchange = handlePhotoFile;
    galleryInput.onchange = handlePhotoFile;
    // One tap on the photo covers both "take a new photo" and "pick an
    // existing one" — a small popup asks which, instead of a separate tap
    // target + text link for each (fewer distinct things to figure out).
    photoTile.onclick = function () {
      showActionSheet({
        title: t('addPhotoTitle'),
        cancelLabel: t('cancelBtn'),
        actions: [
          { icon: '📷', label: t('takePhotoOption'), onClick: function () { cameraInput.click(); } },
          { icon: '🖼', label: t('chooseFromGallery'), onClick: function () { galleryInput.click(); } }
        ]
      });
    };
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

    // history — a single bright button instead of an always-open block, so
    // it doesn't push the rest of the form down. Tapping it opens a
    // view-only popup with the same last-3 entries; only shown once a
    // product actually has history.
    if (!isNew) {
      var histBtn = el('<button type="button" class="btn btn-yellow btn-block">🕒 ' + esc(t('historyBtnLabel')) + '</button>');
      histBtn.onclick = function () {
        var hist = s.history.slice(0, 3);
        var bodyHtml;
        if (!hist.length) {
          bodyHtml = '<div style="font-size:13px;color:var(--ink-muted);">' + esc(t('noHistory')) + '</div>';
        } else {
          bodyHtml = hist.map(function (h) {
            // Older entries from before MRP existed simply have no h.mrp —
            // shown as a dash rather than ₹0, since that's not a real price.
            var mrpCell = (h.mrp === null || h.mrp === undefined || h.mrp === '') ? '—' : money(h.mrp);
            return '<div class="history-row"><div class="when">' + fmtWhen(h.when) + (h.supplier ? ' · ' + esc(h.supplier) : '') + '</div>' +
              '<div class="history-grid">' +
                '<div class="cell"><div class="k">' + esc(t('qtyLabel')) + '</div><div class="v">' + qtyLabel(h.qty, s.unit) + '</div></div>' +
                '<div class="cell pc-cost"><div class="k">' + esc(t('costLabel')) + '</div><div class="v">' + money(h.cost) + '</div></div>' +
                '<div class="cell pc-sell"><div class="k">' + esc(t('sellLabel')) + '</div><div class="v">' + money(h.sell) + '</div></div>' +
                '<div class="cell pc-mrp"><div class="k">' + esc(t('mrpLabel')) + '</div><div class="v">' + mrpCell + '</div></div>' +
              '</div></div>';
          }).join('');
        }
        showModal({ title: t('historyHeading'), bodyHtml: bodyHtml, closeLabel: t('closeBtn') });
      };
      wrap.appendChild(histBtn);
    }

    // description
    var descWrap = el('<div class="field"><label class="label">' + esc(t('descLabel')) + '</label></div>');
    var descArea = el('<textarea class="textarea" maxlength="300" placeholder="' + esc(t('descPh')) + '"></textarea>');
    descArea.value = s ? s.description : '';
    var counter = el('<div class="counter">0/300</div>');
    function updateCounter() { var n = descArea.value.length; counter.textContent = n + '/300'; counter.classList.toggle('near-limit', n > 270); }
    updateCounter();
    descArea.oninput = function () { updateCounter(); checkDirty(); };
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
    var qtyF = el('<div class="field" data-tour="qty-field"><label class="label">' + esc(isReceive ? t('recQtyLabel') : t('totalQtyLabel')) + '</label></div>');
    // inputmode="decimal" makes phones reliably show the number pad (with
    // a decimal point) here instead of the full alphabet keyboard — but
    // only for units where a decimal actually means something. For a
    // whole-number-only unit (piece/dozen/packet — round 4.10) this
    // switches to inputmode="numeric" (hides the decimal key on most
    // phone keyboards) and step="1", so it's hard to even type a decimal
    // by mistake; saveBtn.onclick below still hard-blocks one that slips
    // through some other way (e.g. pasting).
    var qtyInp = el('<input class="input" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0">');
    qtyInp.value = original.qty;
    qtyF.appendChild(qtyInp);
    row1.appendChild(unitF); row1.appendChild(qtyF);
    wrap.appendChild(row1);

    function applyQtyStepForUnit() {
      var whole = isWholeUnit(unitSel.value);
      qtyInp.step = whole ? '1' : '0.01';
      qtyInp.setAttribute('inputmode', whole ? 'numeric' : 'decimal');
    }
    applyQtyStepForUnit();

    // Receive Stock only: every field below starts blank (a fresh entry
    // for THIS batch, not last time's numbers) — this caption exists so
    // that doesn't read as "my data got deleted". Shown for the first 5
    // times only; after that the person already knows and it's dropped
    // to reduce clutter.
    if (isReceive) {
      var capKey = 'hd_receive_caption_seen';
      var seenCount = 0;
      try { seenCount = parseInt(localStorage.getItem(capKey) || '0', 10) || 0; } catch (e) {}
      if (seenCount < 5) {
        wrap.appendChild(el('<div class="list-caption receive-fresh-caption">' + esc(t('receiveFreshCaption')) + '</div>'));
        try { localStorage.setItem(capKey, String(seenCount + 1)); } catch (e) {}
      }
    }

    // Cost / Selling / MRP — one row of three colour-coded cards (round
    // 4.10: Cost=yellow, Selling=green, MRP=grey/neutral, the same three
    // colours reused on the Price History popup below so a colour always
    // means the same thing everywhere). Also the tour's spotlight target
    // for this whole group, since Save is gated on all three together —
    // MRP is the outer bound both prices are validated against.
    var priceGroup = el('<div class="price-row-3" data-tour="price-fields"></div>');
    var costF = el('<div class="field price-card pc-cost"><label class="label">' + esc(t('costLabelShort')) + '</label></div>');
    var costInp = el('<input class="input" type="number" step="0.01" min="0" inputmode="decimal" placeholder="₹" data-tour-field="cost">');
    costInp.value = original.cost;
    costF.appendChild(costInp);
    var sellF = el('<div class="field price-card pc-sell"><label class="label">' + esc(t('sellLabelShort')) + '</label></div>');
    var sellInp = el('<input class="input" type="number" step="0.01" min="0" inputmode="decimal" placeholder="₹" data-tour-field="sell">');
    sellInp.value = original.sell;
    sellF.appendChild(sellInp);
    var mrpF = el('<div class="field price-card pc-mrp"><label class="label">' + esc(t('mrpLabel')) + '</label></div>');
    var mrpInp = el('<input class="input" type="number" step="0.01" min="0" inputmode="decimal" placeholder="' + esc(t('mrpPh')) + '" data-tour-field="mrp">');
    mrpInp.value = original.mrp;
    mrpF.appendChild(mrpInp);
    priceGroup.appendChild(costF); priceGroup.appendChild(sellF); priceGroup.appendChild(mrpF);
    wrap.appendChild(priceGroup);
    [qtyInp, mrpInp, costInp, sellInp].forEach(disableWheelChange);

    // This banner used to be purely advisory — visible the moment the price
    // looks wrong, but Save would go through anyway. It's now the single
    // place this message lives: Save actually refuses to proceed while
    // it's showing (see saveBtn.onclick and checkDirty() below), so its
    // wording matches that instead of a softer "double check before
    // saving" — no separate second banner is shown when Save is blocked,
    // it just draws attention to this one. The rule (round 4.9): cost
    // price ≤ selling price ≤ MRP — a break-even sale or selling right at
    // MRP are both fine; only an out-of-order price is blocked.
    var marginWarn = el('<div class="banner banner-danger" style="display:none;">⚠ ' + esc(t('marginBlockErr')) + '</div>');
    wrap.appendChild(marginWarn);
    function priceInvalid() {
      var c = parseFloat(costInp.value), sl = parseFloat(sellInp.value), m = parseFloat(mrpInp.value);
      // A field that's simply not filled in yet isn't an "ordering"
      // violation — that's caught separately by the required-fields
      // check at Save time. This only flags three real numbers that are
      // actually out of order.
      if (isNaN(c) || isNaN(sl) || isNaN(m)) return false;
      return !(c <= sl && sl <= m);
    }
    function checkMargin() {
      marginWarn.style.display = priceInvalid() ? 'flex' : 'none';
    }
    checkMargin();

    // margin stat (existing items)
    if (!isNew) {
      var margin = s.sell - s.cost;
      var marginPct = s.cost ? Math.round((margin / s.cost) * 100) : 0;
      wrap.appendChild(el(
        '<div class="stat-row">' +
          '<div class="stat-box"><div class="k">' + esc(t('totalQtyLabel')) + '</div><div class="v' + (s.qty <= 0 ? ' qty-negative' : '') + '">' + qtyLabel(s.qty, s.unit) + '</div></div>' +
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

    // Remove-from-catalogue — only for an existing product, and only from
    // the Catalogue tab (Receive Stock is about updating stock, not
    // deleting products). Deliberately small/quiet, not a full-width
    // danger button, since this isn't the main action on this screen.
    if (!isNew && !isReceive) {
      var removeLink = el('<button type="button" class="remove-link">' + esc(t('removeFromCatalogueLink')) + '</button>');
      removeLink.onclick = function () {
        showConfirm({
          title: t('removeConfirmTitle'), body: t('removeConfirmBody'),
          confirmLabel: t('removeConfirmYes'), cancelLabel: t('cancelBtn'), danger: true,
          onConfirm: function () {
            api.setSkuActive(s.id, false).then(function () {
              s.active = false;
              toast(t('removedToast'));
              go('catalogue');
            });
          }
        });
      };
      wrap.appendChild(removeLink);
    }

    // ---- fixed bottom bar: one green Save + one round Close (✕) ----
    // Replaces the old Save/Cancel/Back row. Save stays greyed out until
    // something on the screen actually changes; Close always confirms
    // before leaving, since there's no separate Cancel/revert control any
    // more. Built here (not appended into `wrap`) — render() pulls it out
    // via itemFooterEl and pins it to the bottom of the screen so it's
    // always reachable without scrolling.
    var footer = el('<div class="item-footer"></div>');
    var saveBtn = el('<button type="button" class="footer-save-btn" disabled data-tour="save-btn">' + esc(isReceive ? t('saveUpdateStockBtn') : t('saveBtn')) + '</button>');
    var closeXBtn = el('<button type="button" class="footer-close-btn"><span class="fc-x">✕</span><span class="fc-lbl">' + esc(t('closeBtn')) + '</span></button>');
    footer.appendChild(saveBtn); footer.appendChild(closeXBtn);
    itemFooterEl = footer;

    function checkDirty() {
      var d = nameInput.value !== original.name ||
        descArea.value !== original.description ||
        unitSel.value !== original.unit ||
        String(qtyInp.value) !== String(original.qty) ||
        String(costInp.value) !== String(original.cost) ||
        String(sellInp.value) !== String(original.sell) ||
        String(mrpInp.value) !== String(original.mrp) ||
        pendingPhoto !== original.photo ||
        (supplierInp ? supplierInp.value !== (original.supplier || '') : false);
      // Round 4.9: Save now also stays greyed out while cost/sell/MRP are
      // out of order, even if something else on the screen has genuinely
      // changed — not just at the moment you tap Save.
      saveBtn.disabled = !d || priceInvalid();
      return d;
    }
    nameInput.oninput = checkDirty;
    unitSel.onchange = function () { applyQtyStepForUnit(); checkDirty(); };
    qtyInp.oninput = checkDirty;
    mrpInp.oninput = function () { checkMargin(); checkDirty(); };
    costInp.oninput = function () { checkMargin(); checkDirty(); };
    sellInp.oninput = function () { checkMargin(); checkDirty(); };
    if (supplierInp) supplierInp.oninput = checkDirty;
    checkDirty(); // starts disabled — nothing's been changed yet

    closeXBtn.onclick = function () {
      showConfirm({
        title: t('discardConfirmTitle'), body: t('discardConfirmBody'),
        confirmLabel: t('discardConfirmYes'), cancelLabel: t('cancelBtn'), danger: true,
        onConfirm: function () { go(isReceive ? 'receiveStock' : 'catalogue'); }
      });
    };

    saveBtn.onclick = function () {
      var name = nameInput.value.trim();
      var qty = parseFloat(qtyInp.value), cost = parseFloat(costInp.value), sell = parseFloat(sellInp.value), mrp = parseFloat(mrpInp.value);
      if (!name) { formErr.textContent = '⚠ ' + t('nameRequired'); formErr.style.display = 'flex'; return; }
      if (isNaN(qty) || isNaN(cost) || isNaN(sell) || isNaN(mrp)) { formErr.textContent = '⚠ ' + t('fieldsRequired'); formErr.style.display = 'flex'; return; }
      // Round 4.10: a whole-number-only unit (piece/dozen/packet) can't
      // take a decimal quantity — "2.5 piece" isn't a real amount. Blocks
      // Save exactly like the other validations above/below it, rather
      // than silently rounding (rounding would quietly change a number
      // the person actually typed, which this app avoids everywhere else).
      if (isWholeUnit(unitSel.value) && qty % 1 !== 0) {
        formErr.textContent = '⚠ ' + t('wholeUnitErr', WHOLE_UNIT_LABEL[unitSel.value]);
        formErr.style.display = 'flex';
        return;
      }
      // The margin banner above used to be purely a visual warning — it
      // never actually stopped a bad save from going through. An
      // out-of-order price (cost ≤ sell ≤ MRP required) is now a hard
      // validation failure, same as a missing name or an empty field:
      // Save refuses to proceed until it's fixed. It's already showing the
      // reason (checkMargin() keeps it in sync with these same fields), so
      // this just makes sure the person notices it rather than adding a
      // second, redundant message.
      if (priceInvalid()) { marginWarn.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      var now = new Date();
      var supplierVal = supplierInp ? supplierInp.value.trim() : '';
      // Receive Stock's Rec. Qty is ADDITIVE — whatever's typed gets added
      // to the product's existing Total Qty, rather than replacing it
      // (Catalogue edits still set Total Qty directly, unchanged). The
      // history entry below still records the number actually typed here
      // (the batch amount received, or the Total Qty as set from
      // Catalogue) — not the resulting running total, which Total Qty
      // itself already shows.
      var savedQty = isReceive ? (isNew ? 0 : Number(s.qty) || 0) + qty : qty;
      var histEntry = { when: now, qty: qty, cost: cost, sell: sell, mrp: mrp, supplier: supplierVal };
      // Keep only the most recent 3 entries — the UI only ever shows the
      // last 3 anyway, and letting this grow forever was quietly bloating
      // every product's row (and the database's overall size) with price
      // history nobody could see.
      var newHistory = [histEntry].concat(isNew ? [] : s.history).slice(0, 3);
      var fields = { name: name, description: descArea.value.trim(), photo: pendingPhoto || (s ? s.photo : placeholderPhoto()),
        unit: unitSel.value, qty: savedQty, cost: cost, sell: sell, mrp: mrp, lastSupplier: supplierVal || (s ? s.lastSupplier : ''), history: newHistory };

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

      saveBtn.disabled = true; closeXBtn.disabled = true;
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
        // Fired AFTER navigating away, so the tour (if it's the one
        // driving this save) finds the new product already visible on
        // whichever screen it just landed on, instead of racing the
        // render.
        if (window.HD_TOUR) window.HD_TOUR.signal('item:created', { id: saved.id });
      }).catch(function () {
        formErr.textContent = '⚠ ' + t('genericError');
        formErr.style.display = 'flex';
        closeXBtn.disabled = false;
        saveBtn.disabled = false;
        saveBtn.textContent = esc(isReceive ? t('saveUpdateStockBtn') : t('saveBtn'));
      });
    };

    return wrap;
  }

  C.initOfflineBanner(t);
  C.initUpdateBanner(t);
  C.initInstallPrompt(t);
  C.initBackNav(handleBack);
  boot();
})();
