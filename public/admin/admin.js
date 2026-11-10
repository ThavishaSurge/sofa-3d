// Sofa 3D admin – dependency-free SPA.
const $app = document.getElementById('app');
const $top = document.getElementById('top-right');

// ---------- utils ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const uid = () => Math.random().toString(36).slice(2, 8);
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 2600);
}
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) { renderLogin(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function copyBtn(getText) {
  return h('button', { class: 'small copy', onclick: async (e) => {
    await navigator.clipboard.writeText(getText()).catch(() => {});
    e.target.textContent = 'Copied ✓'; setTimeout(() => (e.target.textContent = 'Copy'), 1500);
  } }, 'Copy');
}

// ---------- routing ----------
window.addEventListener('hashchange', route);
async function route() {
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.loggedIn) return renderLogin();
  $top.replaceChildren(h('button', { class: 'link', onclick: async () => { await api('POST', '/api/logout'); renderLogin(); } }, 'Log out'));
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) return openEditor(m[1]);
  if (location.hash === '#/shopify') return renderSync();
  return renderList();
}

function renderLogin() {
  $top.replaceChildren();
  const pw = h('input', { type: 'password', placeholder: 'Admin password', autofocus: true });
  const submit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/login', { password: pw.value }); route(); }
    catch (err) { toast(err.message, true); }
  };
  $app.replaceChildren(h('form', { class: 'card login', onsubmit: submit },
    h('h2', {}, 'Sign in'), h('div', { class: 'stack' }, pw, h('button', { class: 'primary', type: 'submit' }, 'Sign in'))));
  pw.focus();
}

// ---------- product list ----------
async function renderList() {
  const items = await api('GET', '/api/products');
  const create = async () => {
    const name = prompt('Product name (e.g. "Oslo 3-seater sofa")');
    if (!name) return;
    const p = await api('POST', '/api/products', { name });
    location.hash = `#/p/${p.id}`;
  };
  $app.replaceChildren(
    h('div', { class: 'list-head' }, h('h2', {}, '3D products'),
      h('div', { class: 'row' }, h('button', { onclick: () => (location.hash = '#/shopify') }, '⇅ Shopify sync'), h('button', { class: 'primary', onclick: create }, '+ New product'))),
    h('div', { class: 'card', style: 'padding:0' },
      items.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Shopify handle'), h('th', {}, 'Model'), h('th', {}, 'Options'), h('th', {}, 'Variants'), h('th', {}, 'Updated'))),
        h('tbody', {}, items.map((p) => h('tr', { class: 'click', onclick: () => (location.hash = `#/p/${p.id}`) },
          h('td', {}, h('strong', {}, p.name)),
          h('td', { class: 'mono' }, p.handle || h('span', { class: 'muted' }, '—')),
          h('td', {}, p.hasModel ? h('span', { class: 'pill' }, 'Uploaded') : h('span', { class: 'pill warn' }, 'Missing')),
          h('td', {}, p.options), h('td', {}, p.variants),
          h('td', { class: 'muted' }, new Date(p.updatedAt + 'Z').toLocaleString()))))
      ) : h('div', { class: 'empty' }, 'No products yet. Create one, upload a .glb sofa model and its fabric textures.')));
}

// ---------- Shopify sync ----------
async function renderSync() {
  const [st, items] = await Promise.all([api('GET', '/api/shopify/status'), api('GET', '/api/products')]);
  const s = st.settings;
  const shopDomain = h('input', { value: s.shopDomain, placeholder: 'sabai.design (used when no Admin API token is set)' });
  const query = h('input', { value: s.query, placeholder: 'tag:"group:the-elevate-sofa"', disabled: !st.connected });
  const handles = h('textarea', { rows: 4, placeholder: 'One handle or product URL per line, e.g.\nthe-elevate-natural-96-sofa-in-hemp-blend' }, s.handles);
  const template = h('select', {}, h('option', { value: '' }, '— choose a fully set-up product —'),
    items.map((p) => h('option', { value: p.id, selected: p.id === s.templateId }, `${p.name}${p.handle ? ` (${p.handle})` : ''}`)));
  const auto = h('input', { type: 'checkbox', checked: s.autoSync });
  const $res = h('div');
  const current = () => ({ shopDomain: shopDomain.value.trim(), query: query.value.trim(), handles: handles.value, templateId: template.value, autoSync: auto.checked });
  const run = async (dryRun) => {
    try {
      await api('PUT', '/api/shopify/settings', current());
      $res.replaceChildren(h('p', { class: 'muted' }, dryRun ? 'Checking…' : 'Syncing…'));
      const r = await api('POST', '/api/shopify/sync', { dryRun });
      $res.replaceChildren(resultTable(r.results, dryRun));
      toast(dryRun ? 'Preview ready – nothing was changed' : 'Sync finished');
    } catch (e) { $res.replaceChildren(); toast(e.message, true); }
  };
  const how = { client: 'client credentials', oauth: 'Connect store', token: 'Admin token' }[st.mode];
  const conn = st.connected
    ? h('span', { class: 'pill' }, `Connected to ${st.shopName} (${how}) – read-only`)
    : st.mode ? h('span', { class: 'pill warn' }, `Admin API error: ${st.error}`)
      : h('span', { class: 'pill warn' }, 'Admin API not connected – using public product pages (published products only)');
  $app.replaceChildren(
    h('div', { class: 'list-head' }, h('h2', {}, 'Shopify sync'), h('a', { href: '#/' }, '← Products')),
    h('div', { class: 'card' },
      h('h3', {}, 'Connection'), h('p', { class: 'sub' }, conn),
      st.canInstall && st.mode !== 'token' ? h('div', { class: 'row', style: 'margin-bottom:8px' },
        h('button', { class: st.connected ? '' : 'primary', onclick: () => (location.href = '/api/shopify/install') }, st.installedAt ? 'Reconnect store' : 'Connect store'),
        st.installedAt ? h('button', { class: 'link', onclick: async () => { await api('DELETE', '/api/shopify/token'); renderSync(); } }, 'Disconnect') : null,
        h('span', { class: 'help' }, 'Opens Shopify to approve read-only product access (store owner or staff with app permissions).')) : null,
      h('p', { class: 'help' }, 'Sync only reads from Shopify. It creates or updates products in this app; it never edits your store or theme.'),
      !st.connected ? h('details', {}, h('summary', { class: 'help' }, 'How to connect the store'),
        h('ol', { class: 'help' },
          h('li', {}, 'Shopify Dev Dashboard → create an app for your store with only the read_products scope, and install it.'),
          h('li', {}, 'On Railway (sofa3d service → Variables) set SHOPIFY_SHOP=yourstore.myshopify.com plus SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET – or SHOPIFY_ADMIN_TOKEN if you have one.'),
          h('li', {}, 'Redeploy, then reload this page.'))) : null),
    h('div', { class: 'card' },
      h('h3', {}, 'What to sync'),
      h('div', { class: 'stack' },
        h('label', { class: 'f' }, 'Template – new products copy its model, files and every option effect', template),
        h('label', { class: 'f' }, 'Shopify search (Admin API) – every matching product, drafts included', query),
        h('label', { class: 'f' }, 'And/or these handles', handles),
        h('label', { class: 'f' }, 'Store domain', shopDomain),
        h('label', { class: 'row', style: 'gap:6px' }, auto, 'Re-sync automatically every hour (new variants and new products are picked up)'),
        h('p', { class: 'help' }, 'Options Shopify doesn\'t have on a product (e.g. Fabric, Size) are fixed from its tags, like fabric:Recycled Velvet, size:96" and construction:Natural.',
          s.lastRun ? ` Last sync: ${new Date(s.lastRun.at).toLocaleString()} – ${s.lastRun.ok} ok, ${s.lastRun.errors} error(s).` : ''),
        h('div', { class: 'row' },
          h('button', { onclick: () => run(true) }, 'Preview (changes nothing)'),
          h('button', { class: 'primary', onclick: () => run(false) }, 'Sync now'),
          h('button', { onclick: async () => { await api('PUT', '/api/shopify/settings', current()); toast('Saved'); } }, 'Save settings')))),
    $res);
}
function resultTable(results, dryRun) {
  return h('div', { class: 'card', style: 'padding:0' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Product', 'Result', 'Variants', 'Fixed from tags', 'Needs effects'].map((t) => h('th', {}, t)))),
    h('tbody', {}, results.map((r) => h('tr', { class: r.id ? 'click' : '', onclick: r.id ? () => (location.hash = `#/p/${r.id}`) : null },
      h('td', {}, h('strong', {}, r.title || r.handle), h('div', { class: 'mono muted' }, r.handle, r.status && r.status !== 'ACTIVE' ? ` · ${r.status.toLowerCase()}` : '')),
      h('td', {}, r.action === 'error' ? h('span', { class: 'pill warn' }, r.error) : h('span', { class: 'pill' }, dryRun ? `will be ${r.action}` : r.action)),
      h('td', {}, r.variants ?? '—', r.unmapped ? h('div', { class: 'pill warn' }, `${r.unmapped} not fully mapped`) : null),
      h('td', { class: 'muted' }, (r.fixed || []).join(' · ') || '—'),
      h('td', {}, r.unfilled?.length ? h('span', { class: 'pill warn' }, r.unfilled.join(', ')) : r.action === 'error' ? '' : '✓'))))));
}

// ---------- editor ----------
const S = { product: null, meta: { meshes: [], materials: [], nodes: [] }, tab: 'setup', dirty: false, lastState: null };
let $preview, $root;

async function openEditor(id) {
  const p = await api('GET', `/api/products/${id}`);
  S.product = p; S.dirty = false; S.meta = { meshes: [], materials: [], nodes: [] };
  $preview = h('iframe', { src: `/embed/${p.id}?ui=1&autorotate=0`, title: 'Preview' });
  $root = h('div');
  $app.replaceChildren($root);
  renderEditor();
}

window.addEventListener('message', (e) => {
  if (!$preview || e.source !== $preview.contentWindow) return;
  const d = e.data || {};
  if (d.type === 'sofa3d:meta') { S.meta = d.meta; if (S.tab === 'options' || S.tab === 'setup') renderTab(); }
  if (d.type === 'sofa3d:state') { S.lastState = d.state; const s = document.getElementById('pv-state'); if (s) s.textContent = describeState(d.state); }
  if (d.type === 'sofa3d:ready' && S.restore) { $preview.contentWindow.postMessage({ type: 'sofa3d:setOptions', options: S.restore }, '*'); S.restore = null; }
});
const describeState = (st) => Object.entries(st.selections || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') + (st.variantId ? `  →  variant ${st.variantId}` : '');

function markDirty() { S.dirty = true; document.querySelector('.ed-head')?.classList.add('dirty'); }
async function save() {
  const p = S.product;
  try {
    const r = await api('PUT', `/api/products/${p.id}`, { name: p.name, config: p.config });
    S.product = { ...p, ...r };
    S.dirty = false;
    document.querySelector('.ed-head')?.classList.remove('dirty');
    reloadPreview();
    toast('Saved');
  } catch (e) { toast(e.message, true); }
}
function reloadPreview() {
  S.restore = S.lastState?.selections || null;
  $preview.src = `/embed/${S.product.id}?ui=1&autorotate=0&t=${Date.now()}`;
}
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && S.product) { e.preventDefault(); save(); } });
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

function renderEditor() {
  const p = S.product;
  const title = h('input', { class: 'title', value: p.name, oninput: (e) => { p.name = e.target.value; markDirty(); } });
  const del = async () => {
    if (!confirm(`Delete "${p.name}" and all its files?`)) return;
    await api('DELETE', `/api/products/${p.id}`); S.dirty = false; location.hash = '#/';
  };
  const duplicate = async () => {
    if (S.dirty) await save();
    const name = prompt('Name for the copy', p.name + ' (copy)');
    if (!name) return;
    const r = await api('POST', `/api/products/${p.id}/duplicate`, { name });
    toast('Duplicated – set its Shopify handle and import its variants');
    location.hash = `#/p/${r.id}`;
  };
  $root.replaceChildren(
    h('div', { class: 'ed-head' + (S.dirty ? ' dirty' : '') },
      h('a', { href: '#/', class: 'btn' }, '←'), title, h('span', { class: 'dirty-dot', title: 'Unsaved changes' }),
      h('button', { onclick: duplicate, title: 'Copy model, fabrics and options to a new product (e.g. another construction sold as a separate Shopify product)' }, 'Duplicate'),
      h('button', { class: 'danger', onclick: del }, 'Delete'),
      h('button', { class: 'primary', onclick: save, id: 'save-btn' }, 'Save')),
    h('div', { class: 'editor' },
      h('div', {}, h('div', { class: 'tabs', id: 'tabs' }), h('div', { id: 'tab-body' })),
      h('div', { class: 'preview' },
        h('div', { class: 'frame' }, $preview),
        h('div', { class: 'bar' }, h('span', { class: 'grow', id: 'pv-state' }, ''), h('button', { class: 'small', onclick: reloadPreview }, 'Reload')),
        h('p', { class: 'help' }, 'Preview uses the saved version. Press Save (Ctrl/⌘+S) to see your changes.'))));
  renderTab();
}

function renderTab() {
  const c = S.product.config;
  const tabs = [
    ['setup', 'Model & files'], ['options', 'Options', c.options.length], ['variants', 'Shopify variants', c.variants.length], ['embed', 'Embed'],
  ];
  document.getElementById('tabs').replaceChildren(...tabs.map(([k, label, n]) =>
    h('button', { class: S.tab === k ? 'on' : '', onclick: () => { S.tab = k; renderTab(); } }, label, n != null ? h('span', { class: 'count' }, n) : null)));
  const body = document.getElementById('tab-body');
  const scroll = window.scrollY;
  body.replaceChildren(({ setup: tabSetup, options: tabOptions, variants: tabVariants, embed: tabEmbed })[S.tab]());
  window.scrollTo(0, scroll);
}

// ---------- tab: setup ----------
function dropZone(label, accept, onFiles) {
  const input = h('input', { type: 'file', multiple: true, accept, onchange: (e) => onFiles([...e.target.files]) });
  const z = h('label', { class: 'drop' }, input, label);
  z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', (e) => { e.preventDefault(); z.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
  return z;
}
async function uploadFiles(files) {
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  toast(`Uploading ${files.length} file(s)…`);
  try {
    const r = await api('POST', `/api/products/${S.product.id}/assets`, fd);
    S.product.assets.push(...r.assets);
    // keep local unsaved edits, only adopt the server's model choice
    if (!S.product.config.modelAssetId) S.product.config.modelAssetId = r.config.modelAssetId;
    toast(`Uploaded ${r.assets.length} file(s)`);
    if (r.assets.some((a) => a.kind === 'model')) reloadPreview();
    renderTab();
  } catch (e) { toast(e.message, true); }
}
async function deleteAsset(a) {
  if (!confirm(`Delete ${a.name}?`)) return;
  await api('DELETE', `/api/products/${S.product.id}/assets/${a.id}`);
  S.product.assets = S.product.assets.filter((x) => x.id !== a.id);
  if (S.product.config.modelAssetId === a.id) S.product.config.modelAssetId = null;
  renderTab();
}
function tabSetup() {
  const c = S.product.config;
  const models = S.product.assets.filter((a) => a.kind === 'model');
  const textures = S.product.assets.filter((a) => a.kind === 'texture');
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
  return h('div', {},
    h('div', { class: 'card' },
      h('h3', {}, '3D model'),
      h('p', { class: 'sub' }, 'Upload a .glb file (export from Blender/3ds Max as glTF Binary). Give the fabric parts their own material name, e.g. "Fabric", and wooden legs "Legs". Extra models can be used for construction types that change the shape.'),
      dropZone('Drop .glb files here or click to choose', '.glb', uploadFiles),
      h('div', { class: 'files models' }, models.map((a) => h('div', { class: 'file' + (c.modelAssetId === a.id ? ' main' : '') },
        h('div', { class: 'thumb' }, '⬢'),
        h('div', { class: 'nm', title: a.name }, a.name, h('br'), h('span', { class: 'muted' }, kb(a.size))),
        h('div', { class: 'nm' }, c.modelAssetId === a.id ? h('span', { class: 'pill' }, 'Main model')
          : h('button', { class: 'small', onclick: () => { c.modelAssetId = a.id; markDirty(); renderTab(); } }, 'Make main')),
        h('button', { class: 'x', onclick: () => deleteAsset(a) }, '×')))),
      S.meta.materials.length ? h('p', { class: 'help' }, 'Detected in main model – materials: ', S.meta.materials.map((m) => h('code', {}, m)).flatMap((x) => [x, ' ']),
        h('br'), 'meshes/nodes: ', S.meta.nodes.slice(0, 40).map((m) => h('code', {}, m)).flatMap((x) => [x, ' '])) : null),
    h('div', { class: 'card' },
      h('h3', {}, 'Fabric textures'),
      h('p', { class: 'sub' }, 'Upload seamless fabric images (.jpg/.png/.webp, 1024–2048px). Optional normal/roughness maps add realism. Use light/neutral textures if colours should tint them.'),
      dropZone('Drop fabric images here or click to choose', '.jpg,.jpeg,.png,.webp', uploadFiles),
      h('div', { class: 'files' }, textures.map((a) => h('div', { class: 'file' },
        h('div', { class: 'thumb', style: `background-image:url('${a.url}')` }),
        h('div', { class: 'nm', title: a.name }, a.name),
        h('button', { class: 'x', onclick: () => deleteAsset(a) }, '×'))))),
    h('div', { class: 'card' },
      h('h3', {}, 'Viewer'),
      h('div', { class: 'row' },
        h('label', { class: 'f' }, 'Background', h('select', { onchange: (e) => { c.viewer.background = e.target.value === 'transparent' ? 'transparent' : (c.viewer._bg || '#ffffff'); markDirty(); renderTab(); } },
          h('option', { value: 'transparent', selected: c.viewer.background === 'transparent' }, 'Transparent (blend with page)'),
          h('option', { value: 'color', selected: c.viewer.background !== 'transparent' }, 'Solid colour'))),
        c.viewer.background !== 'transparent' ? h('label', { class: 'f' }, 'Colour', h('input', { type: 'color', value: c.viewer.background, oninput: (e) => { c.viewer.background = c.viewer._bg = e.target.value; markDirty(); } })) : null,
        h('label', { class: 'f' }, 'Exposure', h('input', { type: 'number', step: '0.1', min: '0.2', max: '3', value: c.viewer.exposure ?? 1, oninput: (e) => { c.viewer.exposure = +e.target.value || 1; markDirty(); } })),
        h('label', { class: 'f' }, 'Auto-rotate', h('select', { onchange: (e) => { c.viewer.autoRotate = e.target.value === '1'; markDirty(); } },
          h('option', { value: '0', selected: !c.viewer.autoRotate }, 'Off'), h('option', { value: '1', selected: c.viewer.autoRotate }, 'On'))),
        h('label', { class: 'f' }, 'Floor shadow', h('select', { onchange: (e) => { c.viewer.showFloorShadow = e.target.value === '1'; markDirty(); } },
          h('option', { value: '1', selected: c.viewer.showFloorShadow !== false }, 'On'), h('option', { value: '0', selected: c.viewer.showFloorShadow === false }, 'Off'))))));
}

// ---------- tab: options ----------
const EFFECT_TYPES = {
  texture: 'Fabric texture', color: 'Colour', scale: 'Size (scale)', visibility: 'Show / hide parts', model: 'Swap model',
};
const GUESS = { fabric: 'texture', material: 'texture', colour: 'color', color: 'color', size: 'scale', construction: 'visibility', type: 'visibility', configuration: 'visibility', arm: 'visibility' };
function newEffect(type) {
  if (type === 'texture') return { type, targets: [], map: null, normalMap: null, roughnessMap: null, repeat: 1, roughness: '' };
  if (type === 'color') return { type, targets: [], color: '#9a9a9a' };
  if (type === 'scale') return { type, scale: [1, 1, 1] };
  if (type === 'visibility') return { type, show: [], hide: [] };
  if (type === 'model') return { type, model: null };
}
function swatchStyle(v) {
  const t = (v.effects || []).find((e) => e.type === 'texture' && e.map);
  const a = t && S.product.assets.find((x) => x.id === t.map);
  if (a) return `background-image:url('${a.url}')`;
  const col = (v.effects || []).find((e) => e.type === 'color');
  return col ? `background:${col.color}` : '';
}

function namePicker(label, list, suggestions, onChange, hint) {
  // text input (comma separated) + clickable chips for detected names
  const input = h('input', { value: list.join(', '), placeholder: hint || 'material or mesh names, comma separated',
    oninput: (e) => { list.splice(0, list.length, ...e.target.value.split(',').map((s) => s.trim()).filter(Boolean)); onChange(); refresh(); } });
  const chipBox = h('div', { class: 'chips' });
  function refresh() {
    const on = new Set(list.map(norm));
    chipBox.replaceChildren(...suggestions.map(([name, kind]) => h('span', {
      class: 'chip ' + kind + (on.has(norm(name)) ? ' on' : ''), title: kind === 'mat' ? 'material' : 'mesh / node',
      onclick: () => {
        const i = list.findIndex((x) => norm(x) === norm(name));
        if (i >= 0) list.splice(i, 1); else list.push(name);
        input.value = list.join(', '); onChange(); refresh();
      } }, name)));
  }
  refresh();
  return h('label', { class: 'f targets' }, label, input, chipBox);
}
const matSuggestions = () => [...S.meta.materials.map((m) => [m, 'mat']), ...S.meta.meshes.filter((m) => !S.meta.materials.includes(m)).map((m) => [m, 'mesh'])];
const nodeSuggestions = () => S.meta.nodes.map((n) => [n, 'mesh']);

function assetSelect(kind, value, onChange, allowNone = true) {
  const list = S.product.assets.filter((a) => a.kind === kind);
  return h('select', { onchange: (e) => onChange(e.target.value || null) },
    allowNone ? h('option', { value: '' }, '— none —') : null,
    list.map((a) => h('option', { value: a.id, selected: a.id === value }, a.name)));
}

function effectEditor(e, onRemove, rerenderValue) {
  const ch = () => markDirty();
  const fields = [];
  if (e.type === 'texture') {
    fields.push(namePicker('Apply to (empty = whole model)', e.targets, matSuggestions(), ch));
    fields.push(h('label', { class: 'f' }, 'Fabric image', assetSelect('texture', e.map, (v) => { e.map = v; ch(); rerenderValue(); })));
    fields.push(h('label', { class: 'f' }, 'Normal map', assetSelect('texture', e.normalMap, (v) => { e.normalMap = v; ch(); })));
    fields.push(h('label', { class: 'f' }, 'Roughness map', assetSelect('texture', e.roughnessMap, (v) => { e.roughnessMap = v; ch(); })));
    fields.push(h('label', { class: 'f' }, 'Tiling', h('input', { type: 'number', step: '0.5', min: '0.1', value: e.repeat ?? 1, oninput: (ev) => { e.repeat = +ev.target.value || 1; ch(); } })));
    fields.push(h('label', { class: 'f' }, 'Roughness', h('input', { type: 'number', step: '0.05', min: '0', max: '1', placeholder: 'auto', value: e.roughness ?? '', oninput: (ev) => { e.roughness = ev.target.value; ch(); } })));
  } else if (e.type === 'color') {
    fields.push(namePicker('Apply to (empty = whole model)', e.targets, matSuggestions(), ch));
    const hex = h('input', { value: e.color, style: 'width:90px', oninput: (ev) => { e.color = ev.target.value; picker.value = ev.target.value; ch(); rerenderValue(true); } });
    const picker = h('input', { type: 'color', value: e.color, oninput: (ev) => { e.color = ev.target.value; hex.value = ev.target.value; ch(); rerenderValue(true); } });
    fields.push(h('label', { class: 'f' }, 'Colour', h('div', { class: 'row', style: 'gap:4px' }, picker, hex)));
  } else if (e.type === 'scale') {
    ['Width (X)', 'Height (Y)', 'Depth (Z)'].forEach((lbl, i) => fields.push(h('label', { class: 'f' }, lbl,
      h('input', { type: 'number', step: '0.05', min: '0.1', value: e.scale[i], oninput: (ev) => { e.scale[i] = +ev.target.value || 1; ch(); } }))));
    fields.push(h('span', { class: 'help' }, '1 = original size, 1.25 = 25% wider'));
  } else if (e.type === 'visibility') {
    fields.push(namePicker('Show', e.show, nodeSuggestions(), ch, 'node / mesh names'));
    fields.push(namePicker('Hide', e.hide, nodeSuggestions(), ch, 'node / mesh names'));
  } else if (e.type === 'model') {
    fields.push(h('label', { class: 'f' }, 'Use model', assetSelect('model', e.model, (v) => { e.model = v; ch(); }, false)));
    fields.push(h('span', { class: 'help' }, 'Use when the construction is a different 3D file. Material names should match the main model.'));
  }
  return h('div', { class: 'effect' }, h('span', { class: 'type' }, EFFECT_TYPES[e.type]), fields, h('button', { class: 'small danger', onclick: onRemove, title: 'Remove effect' }, '×'));
}

function valueEditor(opt, v, rerenderOpt) {
  const el = h('div', { class: 'val' });
  const sw = h('div', { class: 'sw', style: swatchStyle(v) });
  const rerenderValue = (swOnly) => { sw.style.cssText = swatchStyle(v); if (!swOnly) el.replaceWith(valueEditor(opt, v, rerenderOpt)); };
  const typeGuess = Object.entries(GUESS).find(([k]) => norm(opt.name).includes(k))?.[1] || 'texture';
  const addSel = h('select', { onchange: (e) => { if (!e.target.value) return; v.effects.push(newEffect(e.target.value)); markDirty(); rerenderValue(); } },
    h('option', { value: '' }, '+ Add effect…'), Object.entries(EFFECT_TYPES).map(([k, l]) => h('option', { value: k }, l + (k === typeGuess ? ' (suggested)' : ''))));
  el.append(
    h('div', { class: 'val-head' }, sw,
      h('input', { value: v.name, placeholder: 'Value name (as in Shopify)', oninput: (e) => { v.name = e.target.value; markDirty(); } }),
      h('input', { value: (v.aliases || []).join(', '), placeholder: 'Aliases (other spellings), comma separated',
        oninput: (e) => { v.aliases = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); markDirty(); } }),
      h('div', { class: 'row', style: 'gap:4px' },
        addSel,
        h('button', { class: 'small danger', title: 'Delete value', onclick: () => { if (!confirm(`Delete value "${v.name}"?`)) return; opt.values.splice(opt.values.indexOf(v), 1); markDirty(); rerenderOpt(); } }, '×'))),
    v.effects.length ? h('div', { class: 'effects' }, v.effects.map((e) => effectEditor(e, () => { v.effects.splice(v.effects.indexOf(e), 1); markDirty(); rerenderValue(); }, rerenderValue)))
      : h('div', { class: 'effects help' }, 'No effect yet – choosing this value won’t change the model.'));
  return el;
}

function optionEditor(opt) {
  const c = S.product.config;
  const el = h('div', { class: 'opt' });
  const rerender = () => el.replaceWith(optionEditor(opt));
  const move = (d) => { const i = c.options.indexOf(opt); const j = i + d; if (j < 0 || j >= c.options.length) return; [c.options[i], c.options[j]] = [c.options[j], c.options[i]]; markDirty(); renderTab(); };
  el.append(
    h('div', { class: 'opt-head' },
      h('input', { value: opt.name, placeholder: 'Option name (e.g. Fabric)', oninput: (e) => { opt.name = e.target.value; markDirty(); } }),
      h('label', { class: 'help' }, 'Default '),
      h('select', { onchange: (e) => { c.defaults[opt.id] = e.target.value; markDirty(); } },
        opt.values.map((v) => h('option', { value: v.id, selected: c.defaults[opt.id] === v.id }, v.name || '(unnamed)'))),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'small', onclick: () => move(-1), title: 'Move up' }, '↑'),
      h('button', { class: 'small', onclick: () => move(1), title: 'Move down' }, '↓'),
      h('button', { class: 'small danger', onclick: () => { if (!confirm(`Delete option "${opt.name}" and its values?`)) return; c.options.splice(c.options.indexOf(opt), 1); delete c.defaults[opt.id]; markDirty(); renderTab(); } }, 'Delete')),
    ...opt.values.map((v) => valueEditor(opt, v, rerender)),
    h('div', { class: 'val' }, h('button', { class: 'small', onclick: () => { opt.values.push({ id: uid(), name: '', aliases: [], effects: [] }); markDirty(); rerender(); } }, '+ Add value')));
  return el;
}

function tabOptions() {
  const c = S.product.config;
  const presets = [['Fabric'], ['Colour'], ['Size'], ['Construction']];
  return h('div', {},
    h('div', { class: 'card' },
      h('h3', {}, 'Options & what they change'),
      h('p', { class: 'sub' }, 'Mirror your Shopify options (Fabric, Colour, Size, Construction…). Give each value one or more effects. ',
        'Tip: import variants from Shopify first – options and values are created for you, then you just add effects.'),
      !S.meta.materials.length ? h('p', { class: 'help' }, 'Material/mesh name suggestions appear once a model is uploaded and the preview has loaded.') : null,
      h('div', { class: 'row' },
        presets.filter(([n]) => !c.options.some((o) => norm(o.name) === norm(n))).map(([n]) =>
          h('button', { onclick: () => { c.options.push({ id: uid(), name: n, values: [] }); markDirty(); renderTab(); } }, '+ ' + n)),
        h('button', { onclick: () => { c.options.push({ id: uid(), name: 'New option', values: [] }); markDirty(); renderTab(); } }, '+ Custom option'))),
    h('div', { style: 'margin-top:14px' }, c.options.map(optionEditor)));
}

// ---------- tab: variants ----------
function tabVariants() {
  const c = S.product.config;
  c.shopify ||= { shopDomain: '', handle: '' };
  const shop = h('input', { value: c.shopify.shopDomain || '', placeholder: 'yourstore.com or yourstore.myshopify.com', oninput: (e) => { c.shopify.shopDomain = e.target.value.trim(); markDirty(); } });
  const handle = h('input', { value: c.shopify.handle || '', placeholder: 'product-handle', oninput: (e) => { c.shopify.handle = e.target.value.trim(); markDirty(); } });
  const json = h('textarea', { rows: 6, placeholder: 'Paste the contents of https://yourstore.com/products/HANDLE.js here' });
  const doImport = async (body) => {
    try {
      if (S.dirty) await save();
      const r = await api('POST', `/api/products/${S.product.id}/import-variants`, body);
      S.product.config = r.config; S.dirty = false;
      toast(`Imported ${r.imported.variants} variants (${r.imported.options.join(', ')})`);
      reloadPreview(); renderTab();
    } catch (e) { toast(e.message, true); }
  };
  const unmapped = c.variants.filter((v) => c.options.some((o) => !v.selections?.[o.id])).length;
  const missingIds = c.variants.filter((v) => !v.id).length;
  const generate = () => {
    const opts = c.options.filter((o) => o.values.length);
    if (!opts.length) return toast('Add options and values first (Options tab)', true);
    const total = opts.reduce((n, o) => n * o.values.length, 1);
    if (total > 2048 && !confirm(`${total} combinations is more than Shopify's 2,048 variant limit. Continue?`)) return;
    const key = (sel) => opts.map((o) => sel?.[o.id] || '').join('|');
    const have = new Set(c.variants.map((v) => key(v.selections)));
    let added = 0;
    const rec = (i, sel) => {
      if (i === opts.length) {
        if (!have.has(key(sel))) {
          c.variants.push({ id: '', title: opts.map((o) => o.values.find((x) => x.id === sel[o.id]).name).join(' / '), options: [], selections: { ...sel }, manual: true });
          added++;
        }
        return;
      }
      for (const v of opts[i].values) rec(i + 1, { ...sel, [opts[i].id]: v.id });
    };
    rec(0, {});
    markDirty(); renderTab();
    if (!added) return toast('All combinations already exist');
    if (c.shopify?.handle) fillIds(false, added);
    else toast(`Added ${added} combination(s) – set the Shopify handle above, then "Fill IDs from Shopify"`);
  };
  const fillIds = async (prune, added) => {
    try {
      if (S.dirty) await save();
      const r = await api('POST', `/api/products/${S.product.id}/fill-variant-ids`, { prune });
      S.product.config = r.config; S.dirty = false;
      const parts = [added ? `Added ${added} combination(s)` : null, `${r.filled} variant ID(s) filled from Shopify`,
        prune ? `${r.removed} row(s) not in Shopify removed` : r.stillMissing ? `${r.stillMissing} row(s) don't exist in Shopify` : null,
        r.shopifyNotInTable ? `${r.shopifyNotInTable} Shopify variant(s) have no row – use Import variants` : null].filter(Boolean);
      toast(parts.join(' · '));
      reloadPreview(); renderTab();
    } catch (e) { toast(e.message, true); }
  };
  const preview = (v) => { if (!v.id || S.dirty) { $preview.contentWindow.postMessage({ type: 'sofa3d:setOptions', options: Object.fromEntries(Object.entries(v.selections || {})) }, '*'); return; } $preview.contentWindow.postMessage({ type: 'sofa3d:setVariant', variantId: v.id }, '*'); S.activeVariant = v.id; document.querySelectorAll('.vt tr').forEach((tr) => tr.classList.toggle('active', tr.dataset.id === v.id)); };
  const newIdInput = h('input', { placeholder: 'Variant ID', class: 'mono', style: 'width:180px' });

  return h('div', {},
    h('div', { class: 'card' },
      h('h3', {}, 'Import from Shopify'),
      h('p', { class: 'sub' }, 'Pulls every variant ID and its option values from the product page – no Shopify app or token needed for published products. Options and values are created automatically and variants are matched by name.'),
      h('div', { class: 'row' },
        h('label', { class: 'f grow' }, 'Store domain', shop),
        h('label', { class: 'f grow' }, 'Product handle', handle),
        h('button', { class: 'primary', onclick: () => doImport({ shopDomain: c.shopify.shopDomain, handle: c.shopify.handle }) }, 'Import variants')),
      h('details', { style: 'margin-top:10px' }, h('summary', { class: 'help' }, 'Store password-protected or product not published? Paste the product JSON instead'),
        h('div', { class: 'stack', style: 'margin-top:8px' }, json,
          h('button', { onclick: () => doImport({ productJson: json.value }) }, 'Import pasted JSON')))),
    h('div', { class: 'card' },
      h('h3', {}, `Variant mapping (${c.variants.length})`),
      h('p', { class: 'sub' }, 'Each Shopify variant ID → the option values shown in 3D. ',
        unmapped ? h('span', { class: 'pill warn' }, `${unmapped} variant(s) not fully mapped`) : c.variants.length ? h('span', { class: 'pill' }, 'All mapped') : null, ' ',
        h('span', { class: 'pill warn', id: 'missing-ids', style: missingIds ? '' : 'display:none' }, `${missingIds} row(s) missing a variant ID`),
        ' Click a row to preview it.'),
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('button', { onclick: generate, title: 'One row per combination of option values; IDs are filled from Shopify when the handle is set' }, '⊞ Generate all combinations'),
        h('button', { onclick: () => fillIds(false), disabled: !c.shopify?.handle, title: 'Look up each row in the Shopify product and fill its variant ID' }, '⇣ Fill IDs from Shopify'),
        missingIds ? h('button', { onclick: () => fillIds(true), disabled: !c.shopify?.handle, title: 'Fill IDs, then delete rows whose combination is not sold in Shopify' }, 'Remove rows not in Shopify') : null,
        h('span', { class: 'help' }, 'Or find an ID in Shopify admin → Products → product → click a variant → the number at the end of the URL.')),
      c.variants.length ? h('div', { class: 'vt' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Variant ID'), h('th', {}, 'Shopify title'), c.options.map((o) => h('th', {}, o.name)), h('th', {}))),
        h('tbody', {}, c.variants.map((v) => h('tr', { 'data-id': v.id, class: S.activeVariant === v.id ? 'active' : '', onclick: (e) => { if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') preview(v); } },
          h('td', {}, h('input', { class: 'mono', value: v.id, placeholder: 'Paste Shopify variant ID', style: 'width:160px;padding:4px 6px;font-size:12px' + (v.id ? '' : ';border-color:#e6a23c'),
            onchange: (e) => {
              const id = e.target.value.trim().replace(/^gid:\/\/shopify\/ProductVariant\//, '');
              if (id && !/^\d+$/.test(id)) { toast('Variant IDs are numbers (find them in the variant URL in Shopify admin)', true); e.target.value = v.id; return; }
              if (id && c.variants.some((x) => x !== v && x.id === id)) { toast('That variant ID is already used on another row', true); e.target.value = v.id; return; }
              v.id = id; e.target.value = id; e.target.style.borderColor = id ? '' : '#e6a23c'; v.manual = true; markDirty();
              const n = c.variants.filter((x) => !x.id).length, pill = document.getElementById('missing-ids');
              if (pill) { pill.textContent = `${n} row(s) missing a variant ID`; pill.style.display = n ? '' : 'none'; }
            } })),
          h('td', {}, v.title),
          c.options.map((o) => h('td', { class: v.selections?.[o.id] ? '' : 'unmapped' },
            h('select', { onchange: (e) => { v.selections ||= {}; if (e.target.value) v.selections[o.id] = e.target.value; else delete v.selections[o.id]; v.manual = true; markDirty(); } },
              h('option', { value: '' }, '—'),
              o.values.map((val) => h('option', { value: val.id, selected: v.selections?.[o.id] === val.id }, val.name))))),
          h('td', {}, h('button', { class: 'small danger', onclick: () => { c.variants.splice(c.variants.indexOf(v), 1); markDirty(); renderTab(); } }, '×'))))))) : h('div', { class: 'empty' }, 'No variants yet – import from Shopify or add one manually.'),
      h('div', { class: 'row', style: 'margin-top:10px' }, newIdInput,
        h('button', { onclick: () => { const id = newIdInput.value.trim(); if (!/^\d+$/.test(id)) return toast('Variant IDs are numbers', true); if (c.variants.some((v) => v.id === id)) return toast('Already exists', true); c.variants.push({ id, title: '(manual)', options: [], selections: {}, manual: true }); markDirty(); renderTab(); } }, '+ Add variant manually'))));
}

// ---------- tab: embed ----------
function tabEmbed() {
  const p = S.product, c = p.config, base = location.origin;
  const themeSnippet = `<div data-sofa3d-handle="{{ product.handle }}"
     data-variant="{{ product.selected_or_first_available_variant.id }}"
     data-aspect="4/3"></div>
<script src="${base}/embed.js" defer></script>`;
  const fixedSnippet = `<div data-sofa3d="${p.id}" data-aspect="4/3"></div>
<script src="${base}/embed.js" defer></script>`;
  const iframe = `<iframe src="${base}/embed/${p.id}" style="width:100%;aspect-ratio:4/3;border:0" allow="fullscreen" loading="lazy"></iframe>`;
  const jsApi = `// From any theme script (custom variant pickers, apps, etc.)
Sofa3D.setVariant(46123456789012);
Sofa3D.setOptions({ Fabric: 'Boucle', Colour: 'Sage', Size: '3 Seater', Construction: 'Chaise Left' });

// Low level, if you embed the iframe yourself:
iframe.contentWindow.postMessage({ type: 'sofa3d:setVariant', variantId: '46123456789012' }, '${base}');`;
  const block = (title, sub, code) => h('div', { class: 'card' }, copyBtn(() => code), h('h3', {}, title), h('p', { class: 'sub' }, sub), h('pre', { class: 'code' }, code));
  return h('div', {},
    !c.shopify?.handle ? h('div', { class: 'card' }, h('span', { class: 'pill warn' }, 'No Shopify handle set'), ' Set it in “Shopify variants” so the universal snippet can find this product.') : null,
    block('1 · Universal theme snippet (recommended)', 'Add once to your product template (Custom Liquid block or main-product section). Products with a 3D configurator show it; others show nothing. Variant clicks are detected automatically.', themeSnippet),
    block('2 · This product only', 'Use on a specific page or a theme without Liquid access.', fixedSnippet),
    block('3 · Plain iframe', 'Static embed. Add ?variant=ID to pre-select, ?ui=1 for built-in option buttons, ?bg=ffffff for a background colour.', iframe),
    block('JavaScript API', 'For custom themes or headless storefronts.', jsApi),
    h('div', { class: 'card' }, h('h3', {}, 'Links'), h('p', {},
      h('a', { href: `/embed/${p.id}?ui=1`, target: '_blank' }, 'Open standalone viewer ↗'), ' · ',
      h('a', { href: `/demo/?product=${p.id}`, target: '_blank' }, 'Open mock Shopify page ↗'))));
}

route();
