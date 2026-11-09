/*!
 * Sofa 3D – Shopify bridge.
 * Usage (product template):
 *   <div data-sofa3d-handle="{{ product.handle }}" data-variant="{{ product.selected_or_first_available_variant.id }}"></div>
 *   <script src="https://YOUR-APP.up.railway.app/embed.js" defer></script>
 * or a fixed product:  <div data-sofa3d="PRODUCT_ID"></div>
 *
 * Optional attributes: data-aspect="4/3" (or data-height="520px"), data-ui="1", data-bg="ffffff",
 *   data-autorotate="1", data-form="#product-form-id" (CSS selector of the product form)
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
    return inst;
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
