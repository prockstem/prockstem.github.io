// Public page. Renders what the server sends: the free store in full, the
// rest as locked placeholders. Real locked data only arrives from
// stores-full, which requires a paid access cookie.
(function () {
  'use strict';

  var API = '/.netlify/functions/';
  var grid = document.getElementById('grid');
  var notice = document.getElementById('notice');
  var unlockPanel = document.getElementById('unlock');
  var payStatus = document.getElementById('pay-status');
  var state = null;

  // ---- formatting ----
  var money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  var compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  function fmtMoney(n) { return money.format(n); }
  function fmtAge(months) {
    if (months < 12) return months + ' mo';
    var years = Math.round(months / 12 * 10) / 10;
    return years + (years === 1 ? ' yr' : ' yrs');
  }
  function fmtMultiple(x) { return x == null ? '—' : x.toFixed(1) + 'x'; }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---- tiny DOM helper (textContent only, never innerHTML with data) ----
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function lockIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('aria-hidden', 'true');
    var rect = document.createElementNS(ns, 'rect');
    ['x', 'y', 'width', 'height', 'rx'].forEach(function (a, i) { rect.setAttribute(a, [4, 11, 16, 10, 2][i]); });
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M8 11V7a4 4 0 0 1 8 0v4');
    svg.appendChild(rect);
    svg.appendChild(path);
    return svg;
  }

  // Placeholder content drawn under the blur. Generated here in the browser;
  // it has nothing to do with the real stores.
  function placeholder(position, category) {
    var seed = [0, 3, 5, 7, 11, 13][position % 6];
    return {
      position: position,
      name: 'Locked store name',
      category: category || 'Category',
      platform: 'Platform',
      askingPrice: 150000 + seed * 21000,
      multiple: 2 + (seed % 5) / 3,
      monthlyRevenue: 20000 + seed * 3100,
      monthlyProfit: 5000 + seed * 700,
      storeAgeMonths: 20 + seed * 3,
      monthlyTraffic: 25000 + seed * 4000,
      whyPicked: 'This note explains why the store made the list. Unlock the list to read it.',
      listingSource: 'Marketplace',
    };
  }

  function metric(label, value, key) {
    return el('div', key ? { class: 'key' } : null, [el('dt', { text: label }), el('dd', { text: value })]);
  }

  function cardBody(s, locked) {
    var top = el('div', { class: 'card-top' }, [
      el('span', { class: 'rank', text: '#' + s.position }),
      el('span', { class: 'badge', text: 'For sale' }),
      s.free ? el('span', { class: 'badge plain free-tag', text: 'Free pick' }) : null,
    ]);
    var img = !locked && s.imageUrl ? el('img', { class: 'card-img', src: s.imageUrl, alt: s.name + ' screenshot', loading: 'lazy' }) : null;
    var link = null;
    if (!locked) {
      link = el('a', {
        class: 'btn btn-outline btn-block',
        href: s.listingUrl,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        text: s.listingSource ? 'View listing on ' + s.listingSource + ' ↗' : 'View listing ↗',
      });
    } else {
      link = el('span', { class: 'btn btn-outline btn-block', text: 'View listing' });
    }
    return el('div', { class: 'card-inner' }, [
      top,
      img,
      el('h3', { text: s.name }),
      el('div', { class: 'meta', text: s.category + ' · ' + s.platform }),
      el('dl', { class: 'metrics' }, [
        metric('Price', fmtMoney(s.askingPrice), true),
        metric('Multiple', fmtMultiple(s.multiple), true),
        metric('Revenue/mo', fmtMoney(s.monthlyRevenue)),
        metric('Profit/mo', fmtMoney(s.monthlyProfit)),
        metric('Age', fmtAge(s.storeAgeMonths)),
        metric('Traffic/mo', compact.format(s.monthlyTraffic)),
      ]),
      el('div', { class: 'note' }, [el('span', { class: 'label', text: 'Why I picked it' }), el('p', { text: s.whyPicked })]),
      el('div', { class: 'card-actions' }, [link]),
    ]);
  }

  function renderCard(s) {
    if (!s.locked) {
      return el('article', { class: 'card' + (s.free ? ' free' : ''), 'aria-label': 'Store #' + s.position + ': ' + s.name }, [cardBody(s, false)]);
    }
    var body = cardBody(placeholder(s.position, s.category), true);
    body.setAttribute('aria-hidden', 'true');
    return el('article', { class: 'card locked', 'aria-label': 'Store #' + s.position + ', locked' }, [
      body,
      el('a', { class: 'lock-overlay', href: '#unlock' }, [
        el('div', null, [
          el('div', { class: 'lock' }, [lockIcon()]),
          el('strong', { text: 'Store #' + s.position + ' is locked' }),
          el('span', { text: s.category }),
        ]),
      ]),
    ]);
  }

  function showNotice(text, kind, link) {
    notice.textContent = '';
    notice.className = 'notice' + (kind ? ' ' + kind : '');
    var span = el('span', { text: text });
    if (link) {
      notice.classList.add('unlocked-banner');
      notice.appendChild(span);
      notice.appendChild(el('a', { class: 'btn btn-outline', href: link.href, text: link.text }));
    } else {
      notice.appendChild(span);
    }
    notice.hidden = false;
  }

  var ACCESS_MESSAGES = {
    ok: ['Welcome back. The full list is unlocked on this device.', 'good'],
    pending: ['Your payment is still pending with PayPal. The list unlocks as soon as it clears.', ''],
    expired: ['Your access covered an earlier edition of the list. You can unlock the current edition below.', ''],
    refunded: ['This purchase was refunded, so this link no longer unlocks the list.', 'bad'],
    invalid: ["That access link isn't valid. Make sure you copied the whole link.", 'bad'],
  };

  function render() {
    var data = state;
    var lockedCount = data.stores.filter(function (s) { return s.locked; }).length;
    var total = data.stores.length;

    document.getElementById('updated').textContent = 'Last updated: ' + fmtDate(data.updatedAt);
    document.getElementById('eyebrow-text').textContent = 'Handpicked · Updated ' + fmtDate(data.updatedAt);
    document.querySelectorAll('[data-locked-count]').forEach(function (n) { n.textContent = lockedCount; });
    var lockedPositions = data.stores.filter(function (s) { return s.locked; }).map(function (s) { return '#' + s.position; });
    document.getElementById('locked-range').textContent = lockedPositions.join(', ');
    var heroUnlock = document.getElementById('hero-unlock');
    heroUnlock.textContent = 'Unlock all ' + lockedCount + ' stores – $' + Number(data.price).toFixed(0);
    document.getElementById('unlock-btn').textContent = heroUnlock.textContent;

    if (data.accessMode === 'forever') {
      document.getElementById('access-term').textContent = 'Lifetime access to the list';
    }

    grid.textContent = '';
    data.stores.forEach(function (s) { grid.appendChild(renderCard(s)); });

    var fromLink = new URLSearchParams(location.search).get('access');
    if (data.unlocked) {
      heroUnlock.hidden = true;
      unlockPanel.hidden = true;
      showNotice('Unlocked. You are seeing all ' + total + ' stores.', 'good', { href: '/success', text: 'Get your personal link' });
    } else {
      heroUnlock.hidden = lockedCount === 0;
      unlockPanel.hidden = lockedCount === 0;
      var reason = fromLink && fromLink !== 'ok' ? fromLink : data.accessState;
      if (ACCESS_MESSAGES[reason] && reason !== 'ok') showNotice(ACCESS_MESSAGES[reason][0], ACCESS_MESSAGES[reason][1]);
    }
    if (fromLink) history.replaceState(null, '', location.pathname + location.hash);
  }

  async function load() {
    try {
      var res = await fetch(API + 'stores-public', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('bad response');
      var pub = await res.json();
      state = pub;
      if (pub.unlocked) {
        var full = await fetch(API + 'stores-full', { credentials: 'same-origin' });
        if (full.ok) {
          var data = await full.json();
          state = Object.assign({}, pub, { stores: data.stores });
        } else {
          state.unlocked = false;
        }
      }
      render();
    } catch (e) {
      grid.textContent = '';
      document.getElementById('updated').textContent = '';
      showNotice("The list couldn't load. Please refresh the page.", 'bad');
    }
  }

  // ---- PayPal ----
  function setPayStatus(text, bad) {
    payStatus.textContent = text || '';
    payStatus.className = 'pay-status' + (bad ? ' bad' : '');
  }

  function loadPayPalSdk(clientId, currency) {
    return new Promise(function (resolve, reject) {
      if (window.paypal) return resolve(window.paypal);
      var s = document.createElement('script');
      s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) +
        '&currency=' + encodeURIComponent(currency) + '&intent=capture&components=buttons';
      s.onload = function () { resolve(window.paypal); };
      s.onerror = function () { reject(new Error('PayPal failed to load')); };
      document.head.appendChild(s);
    });
  }

  async function postJson(path, body) {
    var res = await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, status: res.status, data: data };
  }

  async function startCheckout() {
    var btn = document.getElementById('unlock-btn');
    if (!state || !state.paypal || !state.paypal.clientId || state.paypal.env === 'mock') {
      setPayStatus("Payments aren't set up yet. Please check back soon.", true);
      return;
    }
    btn.disabled = true;
    setPayStatus('Loading secure checkout…');
    try {
      var paypal = await loadPayPalSdk(state.paypal.clientId, state.currency);
      btn.hidden = true;
      setPayStatus('');
      await paypal.Buttons({
        style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 45 },
        createOrder: async function () {
          setPayStatus('');
          var r = await postJson('paypal-create-order');
          if (!r.ok || !r.data.id) throw new Error(r.data.error || 'Could not start the payment');
          return r.data.id;
        },
        onApprove: async function (data, actions) {
          setPayStatus('Confirming your payment…');
          var r = await postJson('paypal-capture-order', { orderID: data.orderID });
          if (r.ok) { location.href = '/success'; return; }
          if (r.data.retry) { setPayStatus(r.data.error, true); return actions.restart(); }
          setPayStatus(r.data.error || 'The payment could not be completed.', true);
        },
        onCancel: function () { setPayStatus('Payment cancelled. You have not been charged.'); },
        onError: function (err) {
          setPayStatus((err && err.message) || 'Something went wrong with PayPal. Please try again.', true);
        },
      }).render('#paypal-buttons');
    } catch (e) {
      btn.hidden = false;
      btn.disabled = false;
      setPayStatus("PayPal couldn't load. Check your connection or ad blocker and try again.", true);
    }
  }

  document.getElementById('unlock-btn').addEventListener('click', startCheckout);
  document.getElementById('year').textContent = new Date().getFullYear();
  load();
})();
