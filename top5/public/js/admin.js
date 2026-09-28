// Admin dashboard. Every request goes to an admin-* function that checks the
// signed session cookie; this script only drives the UI.
(function () {
  'use strict';

  var API = '/.netlify/functions/';
  var $ = function (id) { return document.getElementById(id); };
  var state = { draft: { stores: [], freeId: null }, live: null, unpublishedChanges: false };
  var editing = null; // store being edited in the dialog (copy), or null
  var toastTimer;

  // ---- helpers ----
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function toast(text, bad) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 5000 : 2200);
  }

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtDate(iso, withTime) {
    var opts = { month: 'short', day: 'numeric', year: 'numeric' };
    if (withTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
    return new Date(iso).toLocaleString('en-US', opts);
  }
  function multipleOf(price, monthlyProfit) {
    var annual = Number(monthlyProfit) * 12;
    return annual > 0 && Number(price) >= 0 ? (Number(price) / annual).toFixed(1) + 'x' : '—';
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  async function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.raw) { init.body = opts.raw; init.headers['content-type'] = opts.type; }
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    var res = await fetch(API + path, init);
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 && path !== 'admin-session') { showLogin(); throw new Error('Your session expired. Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
    return data;
  }

  // ---- views ----
  function showLogin() {
    $('dash-view').hidden = true;
    $('logout-btn').hidden = true;
    $('login-view').hidden = false;
    $('password').focus();
  }

  async function showDashboard() {
    $('login-view').hidden = true;
    $('dash-view').hidden = false;
    $('logout-btn').hidden = false;
    await refreshStores();
  }

  function applyState(data) {
    state = data;
    renderPublishBar();
    renderStores();
  }

  async function refreshStores() {
    try { applyState(await api('admin-stores')); }
    catch (e) { toast(e.message, true); }
  }

  function renderPublishBar() {
    var live = state.live;
    $('live-info').textContent = 'edition ' + live.edition + ', published ' + fmtDate(live.publishedAt, true) + ', ' + live.count + ' stores';
    $('dirty-badge').hidden = !state.unpublishedChanges;
    $('clean-note').hidden = state.unpublishedChanges;
  }

  // ---- store list ----
  var dragIndex = null;

  function renderStores() {
    var list = $('store-list');
    var stores = state.draft.stores;
    list.textContent = '';
    $('add-btn').disabled = stores.length >= 5;
    if (!stores.length) {
      list.appendChild(el('li', { class: 'empty', text: 'No stores yet. Add your first one.' }));
      return;
    }
    stores.forEach(function (s, i) {
      var isFree = s.id === state.draft.freeId;
      var thumb = s.imageId ? el('img', { class: 'row-thumb', src: API + 'image?id=' + s.imageId, alt: '' }) : el('span', { class: 'row-thumb none' });
      var freeRadio = el('input', { type: 'radio', name: 'free-pick', 'aria-label': 'Make ' + s.name + ' the free pick' });
      freeRadio.checked = isFree;
      freeRadio.addEventListener('change', function () { state.draft.freeId = s.id; saveDraft('Free pick updated'); });
      var row = el('li', { class: 'store-row' + (isFree ? ' is-free' : ''), draggable: 'true' }, [
        el('span', { class: 'row-pos', text: String(i + 1) }),
        thumb,
        el('div', { class: 'row-main' }, [
          el('strong', { text: s.name }),
          el('span', { text: s.category + ' · ' + s.platform + ' · ' + usd.format(s.askingPrice) + ' · ' + multipleOf(s.askingPrice, s.monthlyProfit) }),
        ]),
        el('label', { class: 'check row-free' }, [freeRadio, 'Free pick']),
        el('div', { class: 'row-actions' }, [
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move up', text: '↑', onclick: function () { move(i, i - 1); } }),
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move down', text: '↓', onclick: function () { move(i, i + 1); } }),
          el('button', { type: 'button', class: 'btn btn-outline btn-sm', text: 'Edit', onclick: function () { openDialog(s); } }),
          el('button', { type: 'button', class: 'btn btn-outline btn-sm', text: 'Delete', onclick: function () { remove(s); } }),
        ]),
      ]);
      row.addEventListener('dragstart', function (e) { dragIndex = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      row.addEventListener('dragend', function () { row.classList.remove('dragging'); dragIndex = null; });
      row.addEventListener('dragover', function (e) { e.preventDefault(); row.classList.add('drop-target'); });
      row.addEventListener('dragleave', function () { row.classList.remove('drop-target'); });
      row.addEventListener('drop', function (e) { e.preventDefault(); row.classList.remove('drop-target'); if (dragIndex !== null) move(dragIndex, i); });
      list.appendChild(row);
    });
  }

  function move(from, to) {
    var stores = state.draft.stores;
    if (to < 0 || to >= stores.length || from === to) return;
    var item = stores.splice(from, 1)[0];
    stores.splice(to, 0, item);
    renderStores();
    saveDraft('Order saved');
  }

  function remove(s) {
    if (!confirm('Delete "' + s.name + '" from the draft? It stays live until you publish.')) return;
    state.draft.stores = state.draft.stores.filter(function (x) { return x.id !== s.id; });
    saveDraft('Store deleted from draft');
  }

  async function saveDraft(message) {
    try {
      applyState(await api('admin-stores', { method: 'PUT', body: state.draft }));
      if (message) toast(message);
      return true;
    } catch (e) {
      toast(e.message, true);
      await refreshStores();
      return false;
    }
  }

  // ---- dialog ----
  var form = $('store-form');
  var FIELDS = ['name', 'category', 'platform', 'monthlyRevenue', 'monthlyProfit', 'askingPrice', 'storeAgeMonths', 'monthlyTraffic', 'whyPicked', 'listingUrl', 'listingSource'];

  function openDialog(store) {
    editing = store ? Object.assign({}, store) : { id: newId(), imageId: null };
    $('dialog-title').textContent = store ? 'Edit store' : 'Add store';
    FIELDS.forEach(function (f) { form.elements[f].value = editing[f] != null ? editing[f] : ''; });
    $('form-error').textContent = '';
    $('image-input').value = '';
    updateImagePreview();
    updateMultiple();
    $('store-dialog').showModal();
    form.elements.name.focus();
  }

  function closeDialog() { $('store-dialog').close(); editing = null; }

  function updateMultiple() {
    $('multiple-preview').value = multipleOf(String(form.elements.askingPrice.value).replace(/[$,]/g, ''), String(form.elements.monthlyProfit.value).replace(/[$,]/g, ''));
  }

  function updateImagePreview() {
    var img = $('image-preview');
    if (editing && editing.imageId) { img.src = API + 'image?id=' + editing.imageId; img.hidden = false; $('image-remove').hidden = false; }
    else { img.removeAttribute('src'); img.hidden = true; $('image-remove').hidden = true; }
  }

  $('image-input').addEventListener('change', async function () {
    var file = this.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { $('form-error').textContent = 'Image must be 2 MB or smaller.'; this.value = ''; return; }
    $('form-error').textContent = 'Uploading image…';
    try {
      var data = await api('admin-upload', { method: 'POST', raw: file, type: file.type });
      editing.imageId = data.id;
      $('form-error').textContent = '';
      updateImagePreview();
    } catch (e) {
      $('form-error').textContent = e.message;
      this.value = '';
    }
  });
  $('image-remove').addEventListener('click', function () { editing.imageId = null; $('image-input').value = ''; updateImagePreview(); });

  form.elements.askingPrice.addEventListener('input', updateMultiple);
  form.elements.monthlyProfit.addEventListener('input', updateMultiple);

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var missing = FIELDS.filter(function (f) { return f !== 'listingSource' && !String(form.elements[f].value).trim(); });
    if (missing.length) { $('form-error').textContent = 'Please fill in every field (only "Listed on" and the image are optional).'; return; }
    FIELDS.forEach(function (f) { editing[f] = form.elements[f].value.trim(); });
    var stores = state.draft.stores.slice();
    var idx = stores.findIndex(function (s) { return s.id === editing.id; });
    if (idx === -1) stores.push(editing); else stores[idx] = editing;
    var previous = state.draft;
    state.draft = { stores: stores, freeId: state.draft.freeId || editing.id };
    try {
      applyState(await api('admin-stores', { method: 'PUT', body: state.draft }));
      closeDialog();
      toast('Saved to draft');
    } catch (err) {
      state.draft = previous;
      $('form-error').textContent = err.message;
    }
  });
  $('dialog-close').addEventListener('click', closeDialog);
  $('dialog-cancel').addEventListener('click', closeDialog);
  $('add-btn').addEventListener('click', function () { openDialog(null); });

  // ---- publish ----
  $('publish-btn').addEventListener('click', async function () {
    var newEdition = $('new-edition').checked;
    var msg = newEdition
      ? 'Publish the draft as a NEW edition? New visitors will need to pay for it; earlier buyers keep access for 30 more days.'
      : 'Publish the draft as an update to the current edition?';
    if (!confirm(msg)) return;
    this.disabled = true;
    try {
      var res = await api('admin-publish', { method: 'POST', body: { newEdition: newEdition } });
      toast('Published edition ' + res.edition);
      await refreshStores();
    } catch (e) { toast(e.message, true); }
    this.disabled = false;
  });

  // ---- tabs ----
  document.querySelectorAll('[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.getAttribute('data-tab');
      document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b === btn)); });
      $('tab-stores').hidden = tab !== 'stores';
      $('tab-purchases').hidden = tab !== 'purchases';
      if (tab === 'purchases') loadPurchases();
    });
  });

  async function loadPurchases() {
    var body = $('purchase-rows');
    body.textContent = '';
    try {
      var data = await api('admin-purchases');
      $('purchase-totals').textContent = data.totals.count + ' paid · $' + data.totals.revenue + ' total (excluding refunds)';
      if (!data.purchases.length) {
        body.appendChild(el('tr', null, [el('td', { colspan: '7', class: 'muted', text: 'No purchases yet.' })]));
        return;
      }
      data.purchases.forEach(function (p) {
        body.appendChild(el('tr', null, [
          el('td', { text: fmtDate(p.createdAt, true) }),
          el('td', { text: p.payerEmail || '—' }),
          el('td', { text: p.amount ? '$' + p.amount + ' ' + (p.currency || '') : '—' }),
          el('td', null, [el('code', { text: p.orderId })]),
          el('td', { text: p.status === 'COMPLETED' ? 'Paid' : p.status === 'PENDING' ? 'Pending' : p.status }),
          el('td', p.refunded ? { class: 'yes', text: 'Yes' } : { text: 'No' }),
          el('td', null, [p.refunded ? null : el('button', {
            type: 'button', class: 'btn btn-outline btn-sm', text: 'Copy link',
            onclick: async function () {
              try {
                var r = await api('admin-purchases', { method: 'POST', body: { orderId: p.orderId } });
                await navigator.clipboard.writeText(r.magicLink);
                toast('Access link copied');
              } catch (e) { toast(e.message, true); }
            },
          })]),
        ]));
      });
    } catch (e) { toast(e.message, true); }
  }

  // ---- auth ----
  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      await api('admin-session', { method: 'POST', body: { password: $('password').value } });
      $('password').value = '';
      await showDashboard();
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  $('logout-btn').addEventListener('click', async function () {
    try { await api('admin-session', { method: 'DELETE' }); } catch (e) {}
    showLogin();
  });

  api('admin-session').then(function (d) { d.signedIn ? showDashboard() : showLogin(); }).catch(showLogin);
})();
