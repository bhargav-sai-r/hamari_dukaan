// =====================================================================
// Interactive in-app demo/tour — owner app only (the worker app is too
// simple to need one, per the round 4.9 design discussion).
//
// HOW THIS STAYS RELIABLE IN AN APP THAT REBUILDS ITS WHOLE SCREEN ON
// EVERY NAVIGATION (owner.js's render() does `app.innerHTML = ''` and
// redraws from scratch):
//
//   1. No MutationObserver, no guessing when the screen changed. owner.js
//      calls HD_TOUR.onRender() itself at every single point its own DOM
//      can change — the end of render(), and after showModal/showConfirm/
//      showActionSheet/closeOverlay/bikriConfirmPopup in common.js/
//      owner.js. Every one of those calls is already free (a no-op) when
//      no tour is running.
//   2. "Did the person do the thing?" is answered one of three ways,
//      picked per step to be the sturdiest fit:
//        - gate:'click'  — this file attaches its own listener straight
//          to the real button/tab/row for the current step, once it can
//          find it. Since the app's OWN click handler was already wired
//          onto that exact same element before this file ever gets a
//          chance to look for it, the app's real handler always runs
//          first — this file's listener firing after it is safe, even
//          when the app's handler navigates away or rebuilds the screen
//          out from under the very element being clicked.
//        - gate:'poll'   — for "did they type something valid yet" steps
//          (name, prices, quantity, worker fields), where there's no
//          single moment that means "done" — this just rechecks a small
//          checkComplete(el) function every 250ms while that step is on
//          screen.
//        - gate:'signal' — for moments this file cannot reliably detect
//          from the DOM alone (a NEW product's server-generated id; an
//          async save actually finishing) — owner.js calls
//          HD_TOUR.signal('name', payload) at the exact right spot, and
//          only after it's already navigated/updated its own state, so
//          by the time this file reacts, the next step's target already
//          exists to be found.
//   3. Never traps anyone: every bubble (except the very first "welcome"
//      screen, which offers "Skip for now" instead) shows a small ✕ that
//      ends the WHOLE tour immediately — including on the mandatory photo
//      step, which only refuses to let you skip PAST it while continuing
//      the tour, never refuses to let you leave the tour altogether.
// =====================================================================
window.HD_TOUR = (function () {
  "use strict";

  var DONE_KEY = 'hd_tour_done';

  var state = {
    active: false,
    stepIndex: -1,      // -1 = welcome card hasn't been dismissed yet
    t: null,
    trackedSkuId: null, // the product created earlier in this same run of the tour
    pollTimer: null,
    gateEl: null,
    gateHandler: null
  };

  function trackedRowSel() { return '[data-tour-sku="' + state.trackedSkuId + '"]'; }

  // ---------------- step script ----------------
  var STEPS = [
    { id: 'add-new', target: '.pinned-add', gate: 'click', text: 'tourStep1' },
    { id: 'photo', target: '#photoTile', gate: 'poll', text: 'tourStep2', noExit: false,
      checkComplete: function (el) { return !!el.querySelector('img'); } },
    { id: 'name', target: '.item-name-input', gate: 'poll', text: 'tourStep3',
      checkComplete: function (el) { return el.value.trim().length > 0; } },
    { id: 'price', target: '[data-tour="price-fields"]', gate: 'poll', text: 'tourStep4',
      checkComplete: function (el) {
        var cEl = el.querySelector('[data-tour-field="cost"]'), sEl = el.querySelector('[data-tour-field="sell"]'), mEl = el.querySelector('[data-tour-field="mrp"]');
        if (!cEl || !sEl || !mEl) return false;
        var c = parseFloat(cEl.value), sl = parseFloat(sEl.value), m = parseFloat(mEl.value);
        return !isNaN(c) && !isNaN(sl) && !isNaN(m) && c <= sl && sl <= m;
      } },
    { id: 'qty', target: '[data-tour="qty-field"] input', gate: 'poll', text: 'tourStep5',
      checkComplete: function (el) { return el.value !== '' && !isNaN(parseFloat(el.value)); } },
    { id: 'save-product', target: '[data-tour="save-btn"]', gate: 'signal', signalName: 'item:created', text: 'tourStep6',
      onSignal: function (payload) { if (payload) state.trackedSkuId = payload.id; } },
    { id: 'catalogue-confirm', target: function () { return trackedRowSel(); }, gate: 'next', text: 'tourStep7' },
    { id: 'tab-receive', target: '[data-tour="tab-receiveStock"]', gate: 'signal', signalName: 'tab:receiveStock', text: 'tourStep8' },
    { id: 'receive-row', target: function () { return trackedRowSel(); }, gate: 'signal', signalName: 'receive:open-tracked-row', text: 'tourStep9pre',
      matchPayload: function (p) { return p && p.id === state.trackedSkuId; } },
    { id: 'receive-qty', target: '[data-tour="qty-field"] input', gate: 'poll', text: 'tourStep9',
      checkComplete: function (el) { return el.value !== ''; } },
    { id: 'receive-price', target: '[data-tour="price-fields"]', gate: 'poll', text: 'tourStep9b',
      checkComplete: function (el) {
        var cEl = el.querySelector('[data-tour-field="cost"]'), sEl = el.querySelector('[data-tour-field="sell"]'), mEl = el.querySelector('[data-tour-field="mrp"]');
        if (!cEl || !sEl || !mEl) return false;
        var c = parseFloat(cEl.value), sl = parseFloat(sEl.value), m = parseFloat(mEl.value);
        return !isNaN(c) && !isNaN(sl) && !isNaN(m) && c <= sl && sl <= m;
      } },
    { id: 'receive-save', target: '[data-tour="save-btn"]', gate: 'click', text: 'tourStep6' },
    { id: 'tab-bikri', target: '[data-tour="tab-bikri"]', gate: 'signal', signalName: 'tab:bikri', text: 'tourStep10' },
    { id: 'bikri-row', target: function () { return trackedRowSel() + ' .bikri-qty-inp'; }, gate: 'signal', signalName: 'bikri:qty-entered', text: 'tourStep11',
      matchPayload: function (p) { return p && p.id === state.trackedSkuId; } },
    { id: 'bikri-cancel-info', target: '[data-tour="bikri-cancel-btn"]', gate: 'next', text: 'tourStep13' },
    { id: 'bikri-record', target: '[data-tour="record-sales-btn"]', gate: 'click', text: 'tourStep14' },
    { id: 'bikri-confirm', target: '#bkConfirm', gate: 'click', text: 'tourStep15' },
    { id: 'today-btn', target: '[data-tour="today-sales-btn"]', gate: 'click', text: 'tourStep16' },
    { id: 'today-modal', target: '.overlay .dialog', gateTarget: '#mdClose', gate: 'click', text: 'tourStep17' },
    { id: 'tab-workers', target: '[data-tour="tab-workers"]', gate: 'signal', signalName: 'tab:workers', text: 'tourStep18' },
    { id: 'add-worker', target: '[data-tour="add-worker-btn"]', gate: 'click', text: 'tourStep19' },
    { id: 'worker-name', target: 'input[name="wname"]', gate: 'poll', text: 'tourStep20',
      checkComplete: function (el) { return el.value.trim().length > 0; } },
    { id: 'worker-phone', target: 'input[name="wphone"]', gate: 'poll', text: 'tourStep21',
      checkComplete: function (el) { return el.value.replace(/\D/g, '').length >= 10; } },
    { id: 'worker-pin', target: 'input[name="wpin"]', gate: 'poll', text: 'tourStep22',
      checkComplete: function (el) { return el.value.length === 4; } },
    { id: 'worker-hint', target: '.banner-neutral', gate: 'next', text: 'tourStep23' },
    { id: 'worker-save', target: '[data-tour="worker-save-btn"]', gate: 'signal', signalName: 'worker:added', text: 'tourStep24' },
    { id: 'worker-confirm', target: '.worker-row', gate: 'next', text: 'tourStep25' }
  ];

  // ---------------- DOM: one root, appended straight to <body> so it's
  // completely untouched by owner.js's app.innerHTML='' rebuilds ----------------
  var root = null, dimEl = null, bubbleEl = null;
  function ensureDom() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'hdTourRoot';
    dimEl = document.createElement('div');
    dimEl.id = 'hdTourDim';
    bubbleEl = document.createElement('div');
    bubbleEl.id = 'hdTourBubble';
    root.appendChild(dimEl);
    root.appendChild(bubbleEl);
    document.body.appendChild(root);
  }
  function removeDom() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = dimEl = bubbleEl = null;
  }

  function resolveSel(sel) {
    if (typeof sel === 'function') { try { sel = sel(); } catch (e) { return null; } }
    if (!sel) return null;
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  function teardownGate() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.gateEl && state.gateHandler) { state.gateEl.removeEventListener('click', state.gateHandler, true); }
    state.gateEl = null; state.gateHandler = null;
  }

  function armGate(step) {
    teardownGate();
    if (step.gate === 'click') {
      var el = resolveSel(step.gateTarget || step.target);
      if (!el) return;
      var handler = function () { advance(); };
      el.addEventListener('click', handler, true);
      state.gateEl = el; state.gateHandler = handler;
    } else if (step.gate === 'poll') {
      state.pollTimer = setInterval(function () {
        var el = resolveSel(step.gateTarget || step.target);
        if (el && step.checkComplete && step.checkComplete(el)) advance();
      }, 250);
    }
    // 'signal' and 'next' need nothing armed here.
  }

  function positionOn(el) {
    if (!el) { dimEl.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    var pad = 6;
    dimEl.style.display = 'block';
    dimEl.style.left = (r.left - pad) + 'px';
    dimEl.style.top = (r.top - pad) + 'px';
    dimEl.style.width = (r.width + pad * 2) + 'px';
    dimEl.style.height = (r.height + pad * 2) + 'px';
  }

  function positionBubble(el) {
    bubbleEl.classList.remove('hd-tour-centered');
    if (!el) { bubbleEl.classList.add('hd-tour-centered'); bubbleEl.style.top = ''; bubbleEl.style.left = ''; return; }
    var r = el.getBoundingClientRect();
    var margin = 12;
    var vw = window.innerWidth, vh = window.innerHeight;
    var w = bubbleEl.offsetWidth, h = bubbleEl.offsetHeight;
    var top = (r.bottom + margin + h < vh) ? r.bottom + margin : (r.top - margin - h > 0 ? r.top - margin - h : Math.max(margin, vh - h - margin));
    var left = Math.max(margin, Math.min(r.left + r.width / 2 - w / 2, vw - w - margin));
    bubbleEl.style.top = top + 'px';
    bubbleEl.style.left = left + 'px';
  }

  function counterHtml(idx) {
    var t = state.t;
    return '<div class="hd-tour-counter">' + t('tourStepCounter', idx + 1, STEPS.length) + '</div>';
  }

  function renderStepBubble(step, targetEl) {
    var t = state.t;
    var html = counterHtml(state.stepIndex) +
      '<div class="hd-tour-text">' + escapeHtml(t(step.text)) + '</div>';
    if (step.gate === 'next') {
      html += '<button type="button" class="btn btn-primary btn-block hd-tour-next">' + escapeHtml(t('tourNextBtn')) + '</button>';
    }
    bubbleEl.innerHTML = '<button type="button" class="hd-tour-x" aria-label="close">✕</button>' + html;
    bubbleEl.querySelector('.hd-tour-x').onclick = stop;
    var nextBtn = bubbleEl.querySelector('.hd-tour-next');
    if (nextBtn) nextBtn.onclick = advance;
    positionBubble(targetEl);
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function relocate() {
    if (!state.active || state.stepIndex < 0) return;
    var step = STEPS[state.stepIndex];
    if (!step) return;
    ensureDom();
    var target = resolveSel(step.target);
    positionOn(target);
    renderStepBubble(step, target);
    if (step.gate === 'click' || step.gate === 'poll') armGate(step);
  }

  function advance() {
    teardownGate();
    state.stepIndex++;
    if (state.stepIndex >= STEPS.length) { finish(); return; }
    relocate();
  }

  function signal(name, payload) {
    if (!state.active || state.stepIndex < 0) return;
    var step = STEPS[state.stepIndex];
    if (!step || step.gate !== 'signal' || step.signalName !== name) return;
    if (step.matchPayload && !step.matchPayload(payload)) return;
    if (step.onSignal) step.onSignal(payload);
    advance();
  }

  function onRender() {
    if (state.active) relocate();
  }

  function showWelcome() {
    ensureDom();
    positionOn(null);
    var t = state.t;
    bubbleEl.classList.add('hd-tour-centered');
    bubbleEl.innerHTML =
      '<div class="hd-tour-title">' + escapeHtml(t('tourWelcomeTitle')) + '</div>' +
      '<div class="hd-tour-text">' + escapeHtml(t('tourWelcomeBody')) + '</div>' +
      '<button type="button" class="btn btn-grad btn-block hd-tour-start">' + escapeHtml(t('tourStartBtn')) + '</button>' +
      '<button type="button" class="btn btn-ghost btn-block hd-tour-skip">' + escapeHtml(t('tourSkipBtn')) + '</button>';
    bubbleEl.querySelector('.hd-tour-start').onclick = function () { state.stepIndex = 0; relocate(); };
    bubbleEl.querySelector('.hd-tour-skip').onclick = stop;
    positionBubble(null);
  }

  function finish() {
    teardownGate();
    markDone();
    ensureDom();
    positionOn(null);
    var t = state.t;
    bubbleEl.classList.add('hd-tour-centered');
    bubbleEl.innerHTML =
      '<div class="hd-tour-title">' + escapeHtml(t('tourCompleteTitle')) + '</div>' +
      '<div class="hd-tour-text">' + escapeHtml(t('tourCompleteBody')) + '</div>' +
      '<button type="button" class="btn btn-grad btn-block hd-tour-done">' + escapeHtml(t('tourDoneBtn')) + '</button>';
    bubbleEl.querySelector('.hd-tour-done').onclick = stop;
    positionBubble(null);
    state.active = false; // steps are over — only the completion card's own Done button remains live
  }

  function markDone() { try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {} }

  function stop() {
    state.active = false;
    teardownGate();
    removeDom();
    markDone();
  }

  function start(t) {
    state.t = t;
    state.active = true;
    state.stepIndex = -1;
    state.trackedSkuId = null;
    showWelcome();
  }

  function maybeAutoStart(t) {
    var done;
    try { done = localStorage.getItem(DONE_KEY); } catch (e) { done = '1'; }
    if (done) return;
    start(t);
  }

  return { start: start, stop: stop, maybeAutoStart: maybeAutoStart, signal: signal, onRender: onRender, isActive: function () { return state.active; } };
})();
