/*!
 * Sofa 3D – Shopify bridge.
 * Usage (product template):
 *   <div data-sofa3d-handle="{{ product.handle }}" data-variant="{{ product.selected_or_first_available_variant.id }}"></div>
 *   <script src="https://YOUR-APP.up.railway.app/embed.js" defer></script>
 * or a fixed product:  <div data-sofa3d="PRODUCT_ID"></div>
 *
 * Optional attributes: data-aspect="4/3" (or data-height="520px"), data-ui="1", data-bg="ffffff",
 *   data-autorotate="1", data-form="#product-form-id" (CSS selector of the product form)
 * Gallery mode – show the 3D view in the product gallery's main image area, with a "3D" tile
 *   left of the thumbnail bar (3D is active on load; clicking a photo thumbnail shows photos):
 *   data-gallery=".product-main-image"  (the gallery box)
 *   data-gallery-thumbs=".js-product-images-nav"  (the thumbnail bar inside it)
 * JS API: window.Sofa3D.setVariant(id), window.Sofa3D.setOptions({Fabric:'Linen'})
 */
(function () {
  if (window.Sofa3D && window.Sofa3D.__loaded) return;
  var script = document.currentScript || document.querySelector('script[src*="/embed.js"]');
  var BASE = new URL(script.src, location.href).origin;
  var instances = [];

  function qsVariant() {
    try { return new URL(location.href).searchParams.get('variant'); } catch (e) { return null; }
  }

  function findForm(el) {
    var sel = el.getAttribute('data-form');
    if (sel) return document.querySelector(sel);
    var section = el.closest('section, .shopify-section, product-info, .product') || document;
    return section.querySelector('form[action*="/cart/add"]') || document.querySelector('form[action*="/cart/add"]');
  }

  function currentVariantId(inst) {
    var form = findForm(inst.el);
    var input = form && form.querySelector('[name="id"]');
    if (input && input.value) return String(input.value);
    return qsVariant() || inst.el.getAttribute('data-variant');
  }

  // Best-effort read of selected option values (fallback when a variant id isn't mapped)
  function currentOptions(inst) {
    var root = inst.el.closest('section, .shopify-section, product-info, .product') || document;
    var out = {};
    root.querySelectorAll('select[name^="options["]').forEach(function (s) {
      var m = s.name.match(/^options\[(.+)\]$/);
      if (m) out[m[1]] = s.value;
    });
    root.querySelectorAll('fieldset').forEach(function (fs) {
      var legend = fs.querySelector('legend');
      var checked = fs.querySelector('input[type="radio"]:checked');
      if (legend && checked) out[legend.textContent.replace(/[:\s]+$/, '').trim()] = checked.value;
    });
    return out;
  }

  // Options-app fields (line item properties), e.g. <select name="properties[Construction]">.
  // Lets you keep a 4th option outside Shopify's 3-option limit.
  function propertyOptions(inst) {
    var form = findForm(inst.el);
    var out = {};
    if (!form) return out;
    var fields = form.querySelectorAll('[name^="properties["]');
    if (form.id) fields = Array.prototype.slice.call(fields).concat(Array.prototype.slice.call(document.querySelectorAll('[form="' + form.id + '"][name^="properties["]')));
    Array.prototype.forEach.call(fields, function (f) {
      var m = f.name.match(/^properties\[(.+)\]$/);
      if (!m || m[1].charAt(0) === '_') return;
      if ((f.type === 'radio' || f.type === 'checkbox') && !f.checked) return;
      if (f.value) out[m[1]] = f.value;
    });
    return out;
  }

  function send(inst, msg) {
    if (!inst.ready) { inst.queue = msg; return; }
    inst.iframe.contentWindow.postMessage(msg, BASE);
  }

  function sync(inst, force) {
    var id = currentVariantId(inst);
    var extra = propertyOptions(inst);
    var sig = id + '|' + JSON.stringify(extra);
    if (!force && sig === inst.lastSig) return;
    inst.lastSig = sig;
    inst.lastVariant = id;
    if (id) send(inst, { type: 'sofa3d:setVariant', variantId: id, fallbackOptions: currentOptions(inst), extraOptions: extra });
    else if (Object.keys(extra).length) send(inst, { type: 'sofa3d:setOptions', options: extra });
  }

  function mount(el, productId) {
    var variant = currentVariantId({ el: el }) || '';
    var params = new URLSearchParams();
    if (variant) params.set('variant', variant);
    ['ui', 'bg', 'autorotate'].forEach(function (k) { var v = el.getAttribute('data-' + k); if (v) params.set(k, v); });

    var wrap = document.createElement('div');
    wrap.className = 'sofa3d-frame';
    wrap.style.cssText = 'position:relative;width:100%;' +
      (el.getAttribute('data-height') ? 'height:' + el.getAttribute('data-height') + ';' : 'aspect-ratio:' + (el.getAttribute('data-aspect') || '4/3') + ';');
    var iframe = document.createElement('iframe');
    iframe.src = BASE + '/embed/' + encodeURIComponent(productId) + (params.toString() ? '?' + params : '');
    iframe.title = el.getAttribute('data-title') || '3D view';
    iframe.loading = 'lazy';
    iframe.allow = 'fullscreen; xr-spatial-tracking';
    iframe.setAttribute('allowfullscreen', '');
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;';
    wrap.appendChild(iframe);
    el.innerHTML = '';
    el.appendChild(wrap);

    var inst = { el: el, iframe: iframe, productId: productId, ready: false, queue: null, lastVariant: variant, lastSig: null };
    instances.push(inst);
    if (el.getAttribute('data-gallery')) galleryMode(el, wrap);
    return inst;
  }

  // ---------- gallery mode ----------
  var CUBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 2.8 20 7v10l-8 4.2L4 17V7z"/><path d="M4 7l8 4.2L20 7M12 11.2V21.2"/></svg>';
  function injectCss() {
    if (document.getElementById('sofa3d-css')) return;
    var st = document.createElement('style');
    st.id = 'sofa3d-css';
    st.textContent =
      '.sofa3d-stage{position:absolute;left:0;top:0;width:100%;z-index:5}' +
      '.sofa3d-thumb{position:absolute;z-index:6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;' +
      'margin:0;padding:0;box-sizing:border-box;background:#fff;border:1px solid #d6d6d6;color:#222;cursor:pointer;' +
      'font:600 12px/1 system-ui,-apple-system,sans-serif;letter-spacing:.04em}' +
      '.sofa3d-thumb svg{width:38%;height:38%}' +
      '.sofa3d-thumb[aria-pressed="true"]{border-color:#222;box-shadow:inset 0 0 0 1px #222}' +
      '.sofa3d-thumb:focus-visible{outline:2px solid #222;outline-offset:2px}' +
      '.sofa3d-thumb.is-pill{flex-direction:row;gap:6px;padding:8px 12px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.15)}' +
      '.sofa3d-thumb.is-pill svg{width:16px;height:16px}';
    document.head.appendChild(st);
  }

  function galleryMode(el, wrap) {
    var box = document.querySelector(el.getAttribute('data-gallery'));
    if (!box) return;
    injectCss();
    var thumbsSel = el.getAttribute('data-gallery-thumbs');
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';

    var stage = document.createElement('div');
    stage.className = 'sofa3d-stage';
    stage.style.background = '#' + (el.getAttribute('data-bg') || 'ffffff').replace(/^#/, ''); // hides the photo underneath
    wrap.style.cssText = 'position:absolute;inset:0;';
    stage.appendChild(wrap);
    box.appendChild(stage);
    el.style.display = 'none';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sofa3d-thumb';
    box.appendChild(btn);

    var on = true, started = Date.now();
    function thumbs() {
      var t = thumbsSel && box.querySelector(thumbsSel);
      return t && t.offsetHeight > 0 && t.querySelector('img') ? t : null;
    }
    // the bar is meant to show (not hidden by the theme, as on phones) but its slider or images
    // haven't finished setting up yet – measuring now would size the 3D view wrongly
    function pending() {
      var t = thumbsSel && box.querySelector(thumbsSel);
      if (!t || getComputedStyle(t).display === 'none' || Date.now() - started > 10000) return false;
      var img = t.querySelector('img');
      var slick = window.jQuery && window.jQuery.fn && window.jQuery.fn.slick;
      return !(img && img.getBoundingClientRect().height > 0 && (!slick || t.classList.contains('slick-initialized')));
    }
    function set(v) {
      on = v;
      // the main slider's dots/progress bar describe the photos, not the 3D view
      [].forEach.call(box.querySelectorAll('.slick-dots'), function (d) {
        if (!(thumbsSel && d.closest(thumbsSel))) d.style.visibility = on ? 'hidden' : '';
      });
      stage.style.display = on ? '' : 'none';
      box.classList.toggle('sofa3d-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      layout();
    }
    function layout() {
      var wait = pending();
      stage.style.visibility = btn.style.visibility = wait ? 'hidden' : '';
      if (wait) return;
      var t = thumbs(), br = box.getBoundingClientRect();
      // cover the main slider's visible width (on phones it runs edge to edge, wider than the box)
      var list = box.querySelector('.slick-list'), lr = list && list.offsetWidth ? list.getBoundingClientRect() : br;
      var vw = document.documentElement.clientWidth;
      var left = Math.max(lr.left, 0), right = Math.min(lr.right, vw);
      // phones (no thumbnail bar): the theme peeks the neighbouring photos past the box on some
      // browsers (seen on iOS), so cover the full screen width there
      if (!t) { left = 0; right = vw; }
      stage.style.left = (left - br.left) + 'px';
      stage.style.width = Math.max(0, right - left) + 'px';
      if (t) {
        var img = t.querySelector('.slick-slide img, img');
        var size = Math.round((img && img.getBoundingClientRect().height) || 64);
        var gap = 10, tr = t.getBoundingClientRect();
        // the bar's "previous" arrow may hang outside it on the left – keep it clear of the 3D tile
        var prev = t.querySelector('.slick-prev'), over = prev && prev.offsetWidth ? Math.max(0, Math.round(tr.left - prev.getBoundingClientRect().left)) : 0;
        var want = size + gap + over;
        if (parseFloat(t.style.marginLeft || 0) !== want) {
          t.style.marginLeft = want + 'px';
          window.dispatchEvent(new Event('resize')); // let the slider re-measure
          tr = t.getBoundingClientRect();
        }
        stage.style.height = Math.max(0, tr.top - br.top - gap) + 'px';
        btn.className = 'sofa3d-thumb';
        btn.innerHTML = CUBE + '<span>3D</span>';
        btn.setAttribute('aria-label', 'View in 3D');
        btn.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + (tr.left - br.left - over - gap - size) + 'px;top:' +
          (tr.top - br.top + (tr.height - size) / 2) + 'px;';
      } else { // no visible thumbnail bar (e.g. mobile): a floating toggle on the image
        stage.style.height = box.clientHeight + 'px';
        btn.className = 'sofa3d-thumb is-pill';
        btn.innerHTML = on ? '<span>Photos</span>' : CUBE + '<span>View in 3D</span>';
        btn.setAttribute('aria-label', on ? 'Show photos' : 'View in 3D');
        btn.style.cssText = 'left:12px;bottom:12px;';
      }
    }
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); set(thumbs() ? true : !on); });
    // any click on a photo thumbnail or a gallery arrow switches to photos
    box.addEventListener('click', function (e) {
      if (!on || btn.contains(e.target) || stage.contains(e.target)) return;
      if (e.target.closest && e.target.closest((thumbsSel ? thumbsSel + ',' : '') + '.slick-arrow')) set(false);
    }, true);
    if (window.ResizeObserver) new ResizeObserver(layout).observe(box);
    window.addEventListener('resize', layout);
    setInterval(layout, 1000); // the theme rebuilds the thumbnails on variant change
    var fast = setInterval(function () { layout(); if (!pending()) clearInterval(fast); }, 100); // settle quickly while the gallery sets up
    set(true);
  }

  function init(el) {
    if (el.__sofa3d) return;
    el.__sofa3d = true;
    var id = el.getAttribute('data-sofa3d');
    if (id) return mount(el, id);
    var handle = el.getAttribute('data-sofa3d-handle');
    if (!handle) return;
    fetch(BASE + '/api/public/lookup?handle=' + encodeURIComponent(handle))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.id) mount(el, j.id);
        else { el.style.display = 'none'; el.dispatchEvent(new CustomEvent('sofa3d:none', { bubbles: true })); }
      })
      .catch(function () { el.style.display = 'none'; });
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== BASE || !e.data || typeof e.data.type !== 'string') return;
    instances.forEach(function (inst) {
      if (e.source !== inst.iframe.contentWindow) return;
      if (e.data.type === 'sofa3d:ready') {
        inst.ready = true;
        if (inst.queue) { send(inst, inst.queue); inst.queue = null; }
        sync(inst, true);
      }
      inst.el.dispatchEvent(new CustomEvent(e.data.type, { detail: e.data, bubbles: true }));
    });
  });

  // Variant change detection – covers Dawn and most themes:
  function syncAll() { instances.forEach(function (i) { sync(i, false); }); }
  document.addEventListener('change', function () { setTimeout(syncAll, 0); setTimeout(syncAll, 300); }, true);
  document.addEventListener('variant:change', syncAll);
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () { var r = orig.apply(this, arguments); setTimeout(syncAll, 0); return r; };
  });
  window.addEventListener('popstate', syncAll);
  setInterval(syncAll, 500); // safety net for themes that swap the form via AJAX

  function scan() { document.querySelectorAll('[data-sofa3d],[data-sofa3d-handle]').forEach(init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  var scanQueued = false;
  new MutationObserver(function () {
    if (scanQueued) return; scanQueued = true;
    setTimeout(function () { scanQueued = false; scan(); }, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.Sofa3D = {
    __loaded: true,
    instances: instances,
    setVariant: function (id) { instances.forEach(function (i) { i.lastVariant = String(id); send(i, { type: 'sofa3d:setVariant', variantId: String(id) }); }); },
    setOptions: function (o) { instances.forEach(function (i) { send(i, { type: 'sofa3d:setOptions', options: o }); }); },
    resetCamera: function () { instances.forEach(function (i) { send(i, { type: 'sofa3d:resetCamera' }); }); },
  };
})();
