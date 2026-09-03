// =====================================================================
// Data-access layer — same shape whether running in demo mode or
// against a real Supabase project. Nothing outside this file needs to
// know which mode it's in.
//
// Data model (round 4): one OWNER account (phone+PIN) can hold several
// STORES. Logging in as an owner returns just an owner_id; the app then
// lists that owner's stores and lets them add more without any further
// login. Workers still belong to exactly one store each, as before.
// All ids (owner/store/worker/sku) are plain numbers starting at 1.
// =====================================================================
window.HD_API = (function () {
  "use strict";

  var DEMO_MODE = window.HD_CONFIG.DEMO_MODE;
  var sb = window.HD_CONFIG.sb;
  var normalizePhone = window.HD_COMMON.normalizePhone;

  // ---------------- demo-mode "database" ----------------
  // Persisted to localStorage (not just an in-memory variable) so that
  // owner.html and worker.html — two separate pages, each with their
  // own JS runtime — see the same demo data on this device. This is
  // still "demo mode": it never leaves this browser/device, and is
  // wiped by "Clear all demo data".
  //
  // Product PHOTOS are deliberately kept OUT of the main demo-db blob
  // and stored one-per-key instead (hd_demo_photo_<skuId>). Photos are
  // by far the biggest thing in this data (base64 images), and the old
  // approach re-saved every single product's photo to localStorage on
  // every single edit — even a plain stock-count update to ONE product
  // was paying the cost of re-writing every OTHER product's photo too.
  // Splitting them out means a normal save only ever writes its own
  // product's data, however large the rest of the catalogue has grown.
  var DEMO_DB_KEY = 'hd_demo_db';
  var PHOTO_KEY_PREFIX = 'hd_demo_photo_';

  function loadDemoDb() {
    var db;
    try {
      var raw = localStorage.getItem(DEMO_DB_KEY);
      db = raw ? JSON.parse(raw) : { owners: [], stores: [], workers: [], skus: [] };
    } catch (e) { db = { owners: [], stores: [], workers: [], skus: [] }; }
    db.owners = db.owners || []; db.stores = db.stores || []; db.workers = db.workers || []; db.skus = db.skus || []; db.sales = db.sales || [];
    (db.sales || []).forEach(function (r) { r.recorded_at = new Date(r.recorded_at); });
    (db.skus || []).forEach(function (s) {
      // Dates don't survive JSON round-trips — rehydrate sku history.
      s.history = (s.history || []).map(function (h) {
        return { when: new Date(h.when), qty: h.qty, cost: h.cost, sell: h.sell, supplier: h.supplier || '' };
      });
      // Re-attach this sku's photo from its own localStorage key.
      try { s.photo = localStorage.getItem(PHOTO_KEY_PREFIX + s.id) || null; } catch (e) { s.photo = null; }
    });
    return db;
  }
  function saveDemoDb() {
    try {
      var slim = {
        owners: demoDb.owners, stores: demoDb.stores, workers: demoDb.workers,
        skus: demoDb.skus.map(function (s) {
          var copy = {}; for (var k in s) if (k !== 'photo') copy[k] = s[k];
          return copy;
        }),
        sales: demoDb.sales.map(function (r) {
          return { id: r.id, store_id: r.store_id, sku_id: r.sku_id, sku_name: r.sku_name, qty: r.qty,
            unit: r.unit, sale_price: r.sale_price, line_total: r.line_total,
            recorded_at: r.recorded_at instanceof Date ? r.recorded_at.toISOString() : r.recorded_at };
        })
      };
      localStorage.setItem(DEMO_DB_KEY, JSON.stringify(slim));
    } catch (e) {}
  }
  function saveSkuPhoto(skuId, photo, previousPhoto) {
    if (photo === previousPhoto) return; // unchanged — skip the write entirely
    try { localStorage.setItem(PHOTO_KEY_PREFIX + skuId, photo || ''); } catch (e) {}
  }

  var demoDb = loadDemoDb();

  // Plain incrementing numbers per table, starting at 1 — matches the
  // real database's identity columns, and is far easier to read/debug
  // than the old random-looking ids.
  function nextId(list) {
    var max = 0;
    list.forEach(function (x) { if (x.id > max) max = x.id; });
    return max + 1;
  }

  // One phone number maps to exactly one login — an owner account (which
  // can hold several stores) OR a worker of one store, never both.
  // Checked across BOTH lists together, and phones are compared in their
  // normalized form (spaces/dashes/+91 stripped) so a number typed two
  // different ways by two different people is still recognised as a match
  // instead of silently creating a duplicate or failing to log in.
  function phoneTaken(phone, opts) {
    opts = opts || {};
    var n = normalizePhone(phone);
    var inOwners = demoDb.owners.some(function (x) { return normalizePhone(x.phone) === n && x.id !== opts.excludeOwnerId; });
    var inWorkers = demoDb.workers.some(function (x) { return normalizePhone(x.phone) === n && x.id !== opts.excludeWorkerId; });
    return inOwners || inWorkers;
  }

  // =====================================================================
  // Offline support for REAL (Supabase) mode.
  //
  // Demo mode is already fully offline — it only ever talks to
  // localStorage. Real mode normally needs the network for every call.
  // The pieces below close that gap for the situations that actually
  // come up on a shop floor with patchy wifi, AND make saves feel
  // instant instead of waiting on a round trip every time:
  //
  //   1. Looking things up while offline (worker checking a price, owner
  //      checking their worker list) — served from the last successful
  //      fetch, cached in localStorage.
  //   2. Editing an existing product's stock/price: the screen updates
  //      immediately (optimistically) whether you're online or not, and
  //      the actual save to Supabase happens in the background. If it's
  //      offline, the edit is queued and pushed automatically the moment
  //      the connection returns ("background sync"). If a real error
  //      happens (not just "offline"), a toast says so.
  //
  // Creating a brand-new owner account, store, worker, or product is NOT
  // optimistic — those need a server-generated id there's no safe way to
  // fake locally, so they still wait for the real network response and
  // show a clear error if it fails.
  // =====================================================================
  function isOnline() { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  function looksOffline(err) {
    if (!isOnline()) return true;
    var msg = ((err && (err.message || err.code)) || '') + '';
    return /fetch|network|failed to fetch/i.test(msg);
  }

  function cacheKey(kind, storeId) { return 'hd_cache_' + kind + '_' + storeId; }
  function readCache(kind, storeId) {
    try { var raw = localStorage.getItem(cacheKey(kind, storeId)); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeCache(kind, storeId, data) {
    try { localStorage.setItem(cacheKey(kind, storeId), JSON.stringify(data)); } catch (e) {}
  }

  var SKU_QUEUE_KEY = 'hd_sku_sync_queue';
  function loadSkuQueue() { try { return JSON.parse(localStorage.getItem(SKU_QUEUE_KEY) || '[]'); } catch (e) { return []; } }
  function saveSkuQueue(q) { try { localStorage.setItem(SKU_QUEUE_KEY, JSON.stringify(q)); } catch (e) {} }
  function queueSkuUpdate(id, fields) {
    var q = loadSkuQueue().filter(function (item) { return item.id !== id; }); // keep only the latest edit per product
    q.push({ id: id, fields: fields, ts: Date.now() });
    saveSkuQueue(q);
  }
  function rawUpdateSkuOverNetwork(id, fields) {
    var row = toDbSku(fields);
    return sb.from('skus').update(row).eq('id', id).select().single().then(function (res) {
      if (res.error) throw mapErr(res.error);
      return fromDbSku(res.data);
    });
  }
  function flushSkuQueue() {
    if (DEMO_MODE || !isOnline()) return;
    var q = loadSkuQueue();
    if (!q.length) return;
    var synced = 0;
    var remaining = q.slice();
    function step() {
      if (!remaining.length) {
        saveSkuQueue(remaining);
        if (synced > 0 && window.HD_COMMON) window.HD_COMMON.toast(window.HD_I18N.STR.syncedChangesToast[document.documentElement.lang === 'hi' ? 'hi' : 'en']);
        return;
      }
      var item = remaining[0];
      rawUpdateSkuOverNetwork(item.id, item.fields).then(function () {
        synced++;
        remaining.shift();
        saveSkuQueue(remaining); // persist progress after every item in case the connection drops again mid-flush
        step();
      }).catch(function () {
        saveSkuQueue(remaining); // still offline (or a real error) — stop here, keep the rest queued for next time
      });
    }
    step();
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', flushSkuQueue);
    if (isOnline()) setTimeout(flushSkuQueue, 0); // pick up anything queued from a previous, interrupted session
  }

  // ---------------- helpers shared by both modes ----------------
  function mapErr(error) {
    var msg = (error && error.message) || '';
    if (msg.indexOf('PHONE_TAKEN') !== -1) return { code: 'PHONE_TAKEN' };
    return { code: 'UNKNOWN', message: msg };
  }
  function historyForDb(history) {
    return (history || []).map(function (h) {
      return { when: h.when instanceof Date ? h.when.toISOString() : h.when, qty: h.qty, cost: h.cost, sell: h.sell, supplier: h.supplier || '' };
    });
  }
  function historyFromDb(history) {
    return (history || []).map(function (h) { return { when: new Date(h.when), qty: h.qty, cost: h.cost, sell: h.sell, supplier: h.supplier || '' }; });
  }
  function toDbSku(f) {
    return { name: f.name, description: f.description || '', photo_url: f.photo, unit: f.unit, qty: f.qty, cost: f.cost, sell: f.sell,
      mrp: (f.mrp === '' || f.mrp === undefined) ? null : f.mrp,
      last_supplier: f.lastSupplier || '', history: historyForDb(f.history) };
  }
  function fromDbSku(r) {
    return { id: r.id, name: r.name, description: r.description || '', photo: r.photo_url, unit: r.unit, qty: Number(r.qty),
      cost: Number(r.cost), sell: Number(r.sell),
      // MRP is nullable at the database level (see round 4.9's migration) —
      // an older product that predates this field simply has no MRP yet,
      // which is a real, valid state (not zero) until someone edits it.
      mrp: (r.mrp === null || r.mrp === undefined) ? null : Number(r.mrp),
      lastSupplier: r.last_supplier || '', history: historyFromDb(r.history),
      // Older rows from before this column existed come back as undefined
      // here (not false) if a stale cached copy is ever read — callers
      // should treat "not exactly false" as active, never bare `.active`.
      active: r.active !== false };
  }
  function fromDbSale(r) {
    return { id: r.id, storeId: r.store_id, skuId: r.sku_id, skuName: r.sku_name, qty: Number(r.qty),
      unit: r.unit, salePrice: Number(r.sale_price), lineTotal: Number(r.line_total), recordedAt: new Date(r.recorded_at) };
  }

  var api = {
    // ---- owner account + stores ----
    signupOwner: function (phone, pin, storeName) {
      phone = normalizePhone(phone);
      if (DEMO_MODE) {
        if (phoneTaken(phone)) return Promise.reject({ code: 'PHONE_TAKEN' });
        var owner = { id: nextId(demoDb.owners), phone: phone, pin: pin };
        demoDb.owners.push(owner);
        var store = { id: nextId(demoDb.stores), owner_id: owner.id, name: storeName };
        demoDb.stores.push(store);
        saveDemoDb();
        return Promise.resolve({ owner_id: owner.id, store_id: store.id, store_name: store.name });
      }
      return sb.rpc('signup_owner', { p_phone: phone, p_pin: pin, p_store_name: storeName }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        var row = res.data && res.data[0];
        return { owner_id: row.owner_id, store_id: row.store_id, store_name: row.store_name };
      });
    },
    loginOwner: function (phone, pin) {
      phone = normalizePhone(phone);
      if (DEMO_MODE) {
        var owner = demoDb.owners.filter(function (x) { return normalizePhone(x.phone) === phone && x.pin === pin; })[0];
        return Promise.resolve(owner ? { owner_id: owner.id } : null);
      }
      return sb.rpc('login_owner', { p_phone: phone, p_pin: pin }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        var row = res.data && res.data[0];
        return row ? { owner_id: row.owner_id } : null;
      });
    },
    listOwnerStores: function (ownerId) {
      if (DEMO_MODE) {
        return Promise.resolve(demoDb.stores.filter(function (s) { return s.owner_id === ownerId; }).map(function (s) { return { id: s.id, name: s.name }; }));
      }
      return sb.rpc('list_owner_stores', { p_owner_id: ownerId }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        return res.data || [];
      });
    },
    addStore: function (ownerId, storeName) {
      if (DEMO_MODE) {
        var store = { id: nextId(demoDb.stores), owner_id: ownerId, name: storeName };
        demoDb.stores.push(store);
        saveDemoDb();
        return Promise.resolve({ id: store.id, name: store.name });
      }
      return sb.rpc('add_store', { p_owner_id: ownerId, p_store_name: storeName }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        var row = res.data && res.data[0];
        return { id: row.id, name: row.name };
      });
    },
    // ---- worker login ----
    loginWorker: function (phone, pin) {
      phone = normalizePhone(phone);
      if (DEMO_MODE) {
        var w = demoDb.workers.filter(function (x) { return normalizePhone(x.phone) === phone && x.pin === pin; })[0];
        if (!w) return Promise.resolve(null);
        var store = demoDb.stores.filter(function (x) { return x.id === w.store_id; })[0];
        return Promise.resolve({ store_id: w.store_id, store_name: store ? store.name : '', worker_id: w.id, worker_name: w.name });
      }
      return sb.rpc('login_worker', { p_phone: phone, p_pin: pin }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        var row = res.data && res.data[0];
        return row ? { store_id: row.store_id, store_name: row.store_name, worker_id: row.worker_id, worker_name: row.worker_name } : null;
      });
    },
    listWorkers: function (storeId) {
      if (DEMO_MODE) return Promise.resolve(demoDb.workers.filter(function (w) { return w.store_id === storeId; }));
      return sb.rpc('list_workers', { p_store_id: storeId }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        var list = res.data || [];
        writeCache('workers', storeId, list);
        return list;
      }).catch(function (err) {
        var cached = looksOffline(err) ? readCache('workers', storeId) : null;
        if (cached) return cached;
        throw err;
      });
    },
    addWorker: function (storeId, name, phone, pin) {
      phone = normalizePhone(phone);
      if (DEMO_MODE) {
        if (phoneTaken(phone)) return Promise.reject({ code: 'PHONE_TAKEN' });
        var w = { id: nextId(demoDb.workers), store_id: storeId, name: name, phone: phone, pin: pin };
        demoDb.workers.push(w);
        saveDemoDb();
        return Promise.resolve({ worker_id: w.id });
      }
      return sb.rpc('add_worker', { p_store_id: storeId, p_name: name, p_phone: phone, p_pin: pin }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        return { worker_id: res.data[0].worker_id };
      });
    },
    updateWorker: function (workerId, name, phone, pin) {
      phone = normalizePhone(phone);
      if (DEMO_MODE) {
        if (phoneTaken(phone, { excludeWorkerId: workerId })) return Promise.reject({ code: 'PHONE_TAKEN' });
        var w = demoDb.workers.filter(function (x) { return x.id === workerId; })[0];
        if (w) { w.name = name; w.phone = phone; w.pin = pin; }
        saveDemoDb();
        return Promise.resolve({});
      }
      return sb.rpc('update_worker', { p_worker_id: workerId, p_name: name, p_phone: phone, p_pin: pin }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        return {};
      });
    },
    // ---- products ----
    listSkus: function (storeId) {
      if (DEMO_MODE) return Promise.resolve(demoDb.skus.filter(function (s) { return s.store_id === storeId; }));
      return sb.from('skus').select('*').eq('store_id', storeId).order('created_at', { ascending: true }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        var list = (res.data || []).map(fromDbSku);
        writeCache('skus', storeId, list); // last-known-good copy, used below if we go offline
        return list;
      }).catch(function (err) {
        var cached = looksOffline(err) ? readCache('skus', storeId) : null;
        if (cached) return cached;
        throw err;
      });
    },
    insertSku: function (storeId, fields) {
      if (DEMO_MODE) {
        var rec = { id: nextId(demoDb.skus), store_id: storeId, name: fields.name, description: fields.description, photo: fields.photo,
          unit: fields.unit, qty: fields.qty, cost: fields.cost, sell: fields.sell, mrp: (fields.mrp === '' || fields.mrp === undefined) ? null : fields.mrp,
          lastSupplier: fields.lastSupplier, history: fields.history,
          active: true };
        demoDb.skus.push(rec);
        saveDemoDb();
        saveSkuPhoto(rec.id, rec.photo, null);
        return Promise.resolve(rec);
      }
      var row = toDbSku(fields); row.store_id = storeId;
      return sb.from('skus').insert(row).select().single().then(function (res) {
        if (res.error) throw mapErr(res.error);
        return fromDbSku(res.data);
      });
    },
    updateSku: function (id, fields) {
      if (DEMO_MODE) {
        var rec = demoDb.skus.filter(function (s) { return s.id === id; })[0];
        var prevPhoto = rec ? rec.photo : null;
        if (rec) { rec.name = fields.name; rec.description = fields.description; rec.photo = fields.photo; rec.unit = fields.unit;
          rec.qty = fields.qty; rec.cost = fields.cost; rec.sell = fields.sell;
          rec.mrp = (fields.mrp === '' || fields.mrp === undefined) ? null : fields.mrp;
          rec.lastSupplier = fields.lastSupplier; rec.history = fields.history; }
        saveDemoDb();
        saveSkuPhoto(id, fields.photo, prevPhoto);
        return Promise.resolve(rec);
      }
      // Real mode: resolve immediately with the edited fields so the screen
      // updates without waiting on the network — the actual save to
      // Supabase happens in the background. Offline: queued and retried
      // automatically once the connection returns (see flushSkuQueue).
      // A genuine (non-offline) failure shows a toast rather than blocking
      // the screen, since by then the user has likely already moved on.
      var optimistic = Object.assign({ id: id }, fields);
      if (!isOnline()) {
        queueSkuUpdate(id, fields);
        return Promise.resolve(Object.assign({}, optimistic, { _pendingSync: true }));
      }
      rawUpdateSkuOverNetwork(id, fields).catch(function (err) {
        if (looksOffline(err)) { queueSkuUpdate(id, fields); return; }
        if (window.HD_COMMON) {
          var lang = document.documentElement.lang === 'hi' ? 'hi' : 'en';
          window.HD_COMMON.toast(window.HD_I18N.STR.saveFailedToast[lang]);
        }
      });
      return Promise.resolve(optimistic);
    },
    // Removes a product from (or brings it back to) the catalogue and
    // Receive Stock, WITHOUT touching any of its other fields — a plain
    // ON/OFF flip, deliberately kept completely separate from updateSku()
    // above. updateSku() always writes a FULL row via toDbSku(), so
    // reusing it here with a partial {active: ...} fields object would
    // risk blanking out the product's name/price/history in the same
    // write. This is intentionally simple: no offline queueing, no
    // optimistic local update — it just needs a live connection, same as
    // adding a brand-new product does.
    setSkuActive: function (id, active) {
      if (DEMO_MODE) {
        var rec = demoDb.skus.filter(function (s) { return s.id === id; })[0];
        if (rec) { rec.active = active; saveDemoDb(); }
        return Promise.resolve(rec || { id: id, active: active });
      }
      return sb.from('skus').update({ active: active }).eq('id', id).select().single().then(function (res) {
        if (res.error) throw mapErr(res.error);
        return fromDbSku(res.data);
      });
    },
    // ---- Bikri (sale recording) ----
    // Commits a whole batch — every product the owner typed a quantity
    // for in one sitting — as a single unit. `lines` is
    // [{ id, name, unit, qty, sellPrice }, …] where qty is how many were
    // sold and sellPrice is that product's CURRENT selling price (snapshot
    // at the moment of recording, so a later price change never rewrites
    // history). In real mode this calls one RPC that does the qty
    // subtraction and the permanent sales-log insert together as one
    // all-or-nothing database transaction, and subtracts from the qty
    // Supabase has RIGHT NOW rather than a number the app read a moment
    // earlier — see record_sales() in the SQL migration for why that
    // matters when more than one person might be recording sales around
    // the same time.
    // Returns [{id, newQty}, …] — one entry per line — for BOTH modes
    // uniformly, so owner.js can just ASSIGN each product's new qty from
    // this result and never has to subtract qty itself. That used to be a
    // real bug: in demo mode, listSkus() hands back the ACTUAL objects
    // from demoDb.skus (not copies), so S.skus entries are the very same
    // objects as demoDb.skus entries — subtracting once here AND once in
    // owner.js silently double-decremented stock on every sale.
    //
    // In real mode the new qty comes straight back from the record_sales()
    // RPC, which computed it from the CURRENT server-side value at update
    // time (not a number read a moment earlier) — so this is the true
    // post-sale balance even if someone else changed stock a second ago.
    // Demo mode has no concurrent-writer concern, so it computes the same
    // shape locally from each line's `currentQty` (captured by
    // currentBikriLines() right when the batch was built).
    recordSales: function (storeId, lines) {
      if (DEMO_MODE) {
        var now = new Date();
        var results = lines.map(function (line) {
          return { id: line.id, newQty: (Number(line.currentQty) || 0) - line.qty };
        });
        lines.forEach(function (line) {
          var rec = demoDb.skus.filter(function (s) { return s.id === line.id; })[0];
          var r = results.filter(function (x) { return x.id === line.id; })[0];
          if (rec && r) rec.qty = r.newQty;
          demoDb.sales.push({
            id: nextId(demoDb.sales), store_id: storeId, sku_id: line.id, sku_name: line.name,
            qty: line.qty, unit: line.unit, sale_price: line.sellPrice, line_total: line.qty * line.sellPrice,
            recorded_at: now
          });
        });
        saveDemoDb();
        return Promise.resolve(results);
      }
      var payload = lines.map(function (line) {
        return { sku_id: line.id, sku_name: line.name, qty: line.qty, unit: line.unit, sale_price: line.sellPrice };
      });
      return sb.rpc('record_sales', { p_store_id: storeId, p_lines: payload }).then(function (res) {
        if (res.error) throw mapErr(res.error);
        return (res.data || []).map(function (row) {
          return { id: row.sku_id, newQty: Number(row.new_qty) };
        });
      });
    },
    // Every sale recorded today for this store — backs the "Aaj ka Bikri"
    // summary button on the Bikri tab. "Today" is this device's local
    // calendar day, converted to a UTC range for the query, so it lines
    // up with how the shop actually thinks about "today" regardless of
    // where the database server itself is.
    listSalesForToday: function (storeId) {
      var now = new Date();
      if (DEMO_MODE) {
        var todayStr = now.toDateString();
        var rows = demoDb.sales.filter(function (r) { return r.store_id === storeId && new Date(r.recorded_at).toDateString() === todayStr; });
        rows.sort(function (a, b) { return new Date(b.recorded_at) - new Date(a.recorded_at); });
        return Promise.resolve(rows.map(function (r) {
          return { skuId: r.sku_id, skuName: r.sku_name, qty: r.qty, unit: r.unit, salePrice: r.sale_price, lineTotal: r.line_total, recordedAt: new Date(r.recorded_at) };
        }));
      }
      var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      var endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      return sb.from('sales').select('*').eq('store_id', storeId).gte('recorded_at', startOfDay).lt('recorded_at', endOfDay)
        .order('recorded_at', { ascending: false }).then(function (res) {
          if (res.error) throw mapErr(res.error);
          return (res.data || []).map(fromDbSale);
        });
    },
    // Demo-mode-only: wipe everything (used by the "Clear all demo data" menu item).
    clearDemoData: function () {
      demoDb = { owners: [], stores: [], workers: [], skus: [], sales: [] };
      try {
        localStorage.removeItem(DEMO_DB_KEY);
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf(PHOTO_KEY_PREFIX) === 0) localStorage.removeItem(k);
        });
      } catch (e) {}
    }
  };

  return api;
})();
