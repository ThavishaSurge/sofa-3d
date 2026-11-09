import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { fakeShopifyProduct } from '../scripts/seed-demo.js';

let server, base, shop, shopBase, cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sofa3d-test-'));
const SAMPLE = path.resolve('sample');

async function call(method, url, body, { auth = true } = {}) {
  const opts = { method, headers: auth ? { cookie } : {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(base + url, opts);
  const sc = res.headers.get('set-cookie');
  if (sc && sc.startsWith('sofa3d_session=')) cookie = sc.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  if (!fs.existsSync(path.join(SAMPLE, 'sofa.glb'))) throw new Error('Run `npm run sample` first');
  const { app } = createApp({ DATA_DIR: dataDir, ADMIN_PASSWORD: 'secret', FRAME_ANCESTORS: 'https://shop.example.com https://admin.shopify.com' });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  // mock Shopify storefront serving /products/<handle>.js
  shop = http.createServer((req, res) => {
    const m = req.url.match(/^\/products\/([\w-]+)\.js$/);
    if (!m || m[1] === 'missing') { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
    if (m[1].startsWith('velvet-')) return res.end(JSON.stringify(velvetJs(m[1], ['Moss', 'Ash'])));
    res.end(JSON.stringify(fakeShopifyProduct(m[1])));
  }).listen(0);
  shopBase = `http://127.0.0.1:${shop.address().port}`;
});
after(() => { server.close(); shop.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

let pid;
test('admin API requires login', async () => {
  assert.equal((await call('GET', '/api/products', undefined, { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'secret' })).status, 200);
  assert.ok(cookie);
  assert.equal((await call('GET', '/api/me')).json.loggedIn, true);
});

test('create product and upload model + textures', async () => {
  const p = await call('POST', '/api/products', { name: 'Test Sofa' });
  assert.equal(p.status, 201);
  pid = p.json.id;
  const fd = new FormData();
  for (const f of ['sofa.glb', 'linen.png', 'velvet.png']) fd.append('files', new Blob([fs.readFileSync(path.join(SAMPLE, f))]), f);
  fd.append('files', new Blob(['nope']), 'evil.exe');
  const up = await call('POST', `/api/products/${pid}/assets`, fd);
  assert.equal(up.status, 201);
  assert.equal(up.json.assets.length, 3, 'unsupported file is skipped');
  const model = up.json.assets.find((a) => a.kind === 'model');
  assert.equal(up.json.config.modelAssetId, model.id, 'first model becomes main model');
  const file = await fetch(base + model.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'model/gltf-binary');
  assert.equal((await file.arrayBuffer()).byteLength, fs.statSync(path.join(SAMPLE, 'sofa.glb')).size);
});

test('rejects upload with only unsupported files', async () => {
  const fd = new FormData();
  fd.append('files', new Blob(['x']), 'a.txt');
  const r = await call('POST', `/api/products/${pid}/assets`, fd);
  assert.equal(r.status, 400);
});

test('import variants from Shopify storefront URL builds options and maps every variant', async () => {
  const r = await call('POST', `/api/products/${pid}/import-variants`, { shopDomain: shopBase, handle: 'oslo-sofa' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = r.json.config;
  assert.deepEqual(c.options.map((o) => o.name), ['Fabric', 'Colour', 'Size', 'Construction']);
  assert.equal(c.variants.length, 108);
  assert.ok(c.variants.every((v) => Object.keys(v.selections).length === 4), 'all variants fully mapped');
  assert.equal(c.shopify.handle, 'oslo-sofa');
  const missing = await call('POST', `/api/products/${pid}/import-variants`, { shopDomain: shopBase, handle: 'missing' });
  assert.equal(missing.status, 400);
});

test('re-import keeps existing options, effects and manual mappings', async () => {
  const p = (await call('GET', `/api/products/${pid}`)).json;
  const fabric = p.config.options.find((o) => o.name === 'Fabric');
  fabric.values[0].effects = [{ type: 'texture', targets: ['Fabric'], map: p.assets.find((a) => a.name === 'linen.png').id, repeat: 2 }];
  fabric.values[1].aliases = ['Velvet Luxe'];
  const v0 = p.config.variants[0];
  v0.selections[fabric.id] = fabric.values[1].id; v0.manual = true;
  assert.equal((await call('PUT', `/api/products/${pid}`, { name: p.name, config: p.config })).status, 200);
  const r = await call('POST', `/api/products/${pid}/import-variants`, { shopDomain: shopBase, handle: 'oslo-sofa' });
  const c = r.json.config;
  assert.equal(c.options.length, 4, 'no duplicated options');
  assert.equal(c.options[0].values.length, 3, 'no duplicated values');
  assert.equal(c.options[0].values[0].effects.length, 1, 'effects kept');
  assert.equal(c.variants[0].selections[fabric.id], fabric.values[1].id, 'manual mapping kept');
});

test('import from pasted product JSON (/products/handle.json shape)', async () => {
  const p2 = (await call('POST', '/api/products', { name: 'Armchair' })).json;
  const raw = { product: { title: 'Armchair', handle: 'armchair', options: [{ name: 'Colour' }],
    variants: [{ id: 1, title: 'Red', option1: 'Red' }, { id: 2, title: 'Blue', option1: 'Blue' }] } };
  const r = await call('POST', `/api/products/${p2.id}/import-variants`, { productJson: JSON.stringify(raw) });
  assert.equal(r.status, 200);
  assert.equal(r.json.config.variants.length, 2);
  assert.equal(r.json.config.options[0].values.length, 2);
});

test('same Shopify handle cannot be used twice', async () => {
  const p3 = (await call('POST', '/api/products', { name: 'Dupe' })).json;
  const r = await call('PUT', `/api/products/${p3.id}`, { name: 'Dupe', config: { shopify: { handle: 'oslo-sofa' }, options: [], variants: [] } });
  assert.equal(r.status, 409);
});

test('public endpoints: lookup by handle, config, embed page, embed.js', async () => {
  const look = await call('GET', '/api/public/lookup?handle=Oslo-Sofa', undefined, { auth: false });
  assert.equal(look.json.id, pid);
  assert.equal(look.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('GET', '/api/public/lookup?handle=nope', undefined, { auth: false })).status, 404);

  const pub = await call('GET', `/api/public/products/${pid}`, undefined, { auth: false });
  assert.equal(pub.status, 200);
  assert.ok(pub.json.assets[pub.json.modelAssetId].url.startsWith('/files/'));
  assert.equal(pub.json.variants[0].options, undefined, 'public payload is trimmed');

  const page = await fetch(`${base}/embed/${pid}`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors https:\/\/shop\.example\.com https:\/\/admin\.shopify\.com/);
  assert.ok(html.includes(`"id":"${pid}"`));
  assert.ok(!html.includes('__CONFIG__'));

  const js = await fetch(`${base}/embed.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/vendor/three/build/three.module.js`)).status, 200);
});

test('product names cannot inject script into the embed page', async () => {
  const p = (await call('POST', '/api/products', { name: '</script><script>alert(1)</script>' })).json;
  const html = await (await fetch(`${base}/embed/${p.id}`)).text();
  assert.ok(!html.includes('<script>alert(1)'));
});

test('delete product removes files', async () => {
  const p = (await call('GET', `/api/products/${pid}`)).json;
  const url = p.assets[0].url;
  assert.equal((await call('DELETE', `/api/products/${pid}`)).status, 200);
  assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await call('GET', '/api/public/lookup?handle=oslo-sofa', undefined, { auth: false })).status, 404);
});

test('duplicate copies files and remaps asset ids, clears handle + variants', async () => {
  const p = (await call('POST', '/api/products', { name: 'Orig' })).json;
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(path.join(SAMPLE, 'sofa.glb'))]), 'sofa.glb');
  fd.append('files', new Blob([fs.readFileSync(path.join(SAMPLE, 'linen.png'))]), 'linen.png');
  const up = (await call('POST', `/api/products/${p.id}/assets`, fd)).json;
  const tex = up.assets.find((a) => a.kind === 'texture').id;
  const cfg = { ...up.config, shopify: { handle: 'orig-sofa' }, options: [{ id: 'f', name: 'Fabric', values: [{ id: 'l', name: 'Linen', effects: [{ type: 'texture', map: tex }] }] }], variants: [{ id: '1', selections: { f: 'l' } }] };
  await call('PUT', `/api/products/${p.id}`, { name: 'Orig', config: cfg });
  const d = await call('POST', `/api/products/${p.id}/duplicate`, { name: 'Copy' });
  assert.equal(d.status, 201);
  const copy = (await call('GET', `/api/products/${d.json.id}`)).json;
  assert.equal(copy.name, 'Copy');
  assert.equal(copy.assets.length, 2);
  assert.ok(!copy.assets.some((a) => a.id === tex));
  assert.equal(copy.config.options[0].values[0].effects[0].map, copy.assets.find((a) => a.kind === 'texture').id);
  assert.equal(copy.config.modelAssetId, copy.assets.find((a) => a.kind === 'model').id);
  assert.equal(copy.config.shopify.handle, '');
  assert.equal(copy.config.variants.length, 0);
  assert.equal((await fetch(base + copy.assets[0].url)).status, 200);
});

test('saving rejects the same Shopify variant ID on two rows', async () => {
  const p = (await call('POST', '/api/products', { name: 'Dupe ids' })).json;
  const r = await call('PUT', `/api/products/${p.id}`, { name: 'x', config: { options: [], variants: [{ id: '5', selections: {} }, { id: '5', selections: {} }, { id: '', selections: {} }, { id: '', selections: {} }] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /5/);
});

// ---------- Shopify sync ----------
const TAGS = ['collection:Elevate', 'fabric:Recycled Velvet', 'size:96"', 'construction:Natural'];
const velvetJs = (handle, colors) => ({ title: 'Elevate in Velvet', handle, tags: TAGS,
  options: [{ name: 'Color', values: colors }], variants: colors.map((c, i) => ({ id: 900 + i, title: c, options: [c] })) });

async function makeTemplate() {
  const t = (await call('POST', '/api/products', { name: 'Elevate template' })).json;
  const fx = (color) => [{ type: 'color', targets: [], color }];
  const config = { ...t.config, options: [
    { id: 'fab', name: 'Fabric', values: [{ id: 'hemp', name: 'Hemp Blend', aliases: [], effects: fx('#111111') }, { id: 'vel', name: 'Recycled Velvet', aliases: [], effects: fx('#222222') }] },
    { id: 'sz', name: 'Size & Construction', values: [{ id: 's86', name: '86" - Standard', aliases: [], effects: fx('#333333') }, { id: 's96n', name: '96" - Natural', aliases: [], effects: fx('#444444') }] },
    { id: 'col', name: 'Color', values: [{ id: 'moss', name: 'Moss', aliases: [], effects: fx('#555555') }] }] };
  assert.equal((await call('PUT', `/api/products/${t.id}`, { name: t.name, config })).status, 200);
  return t.id;
}

test('import fixes options missing from Shopify using the product tags', async () => {
  const tid = await makeTemplate();
  const r = await call('POST', `/api/products/${tid}/import-variants`, { productJson: { product: { ...velvetJs('velvet-pasted', ['Moss']), tags: TAGS.join(', ') } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = r.json.config;
  assert.deepEqual(c.shopify.fixed, { fab: 'vel', sz: 's96n' });
  assert.deepEqual(c.variants[0].selections, { fab: 'vel', sz: 's96n', col: 'moss' });
  assert.equal(c.defaults.fab, 'vel');
});

test('sync by handle creates from template, then updates in place', async () => {
  const tid = await makeTemplate();
  const before = (await call('GET', '/api/products')).json.length;
  const settings = { shopDomain: shopBase, handles: `${shopBase}/products/velvet-a`, templateId: tid };
  const dry = await call('POST', '/api/shopify/sync', { settings, dryRun: true });
  assert.equal(dry.json.results[0].action, 'created');
  assert.equal((await call('GET', '/api/products')).json.length, before, 'dry run changes nothing');
  const r = await call('POST', '/api/shopify/sync', { settings });
  const res0 = r.json.results[0];
  assert.equal(res0.action, 'created', JSON.stringify(r.json));
  assert.deepEqual(res0.fixed, ['Fabric: Recycled Velvet', 'Size & Construction: 96" - Natural']);
  assert.deepEqual(res0.unfilled, ['Color: Ash']);
  const p = (await call('GET', `/api/products/${res0.id}`)).json;
  assert.equal(p.config.variants.length, 2);
  assert.ok(p.config.variants.every((v) => Object.keys(v.selections).length >= 2));
  assert.equal((await call('GET', '/api/public/lookup?handle=velvet-a', undefined, { auth: false })).json.id, res0.id);
  const again = await call('POST', '/api/shopify/sync', { settings });
  assert.equal(again.json.results[0].action, 'updated');
  assert.equal(again.json.results[0].id, res0.id);
  assert.equal((await call('GET', '/api/products')).json.length, before + 1, 'no duplicate on re-sync');
});

test('sync with Admin API: client-credentials token, search query, paginated variants', async () => {
  const colors = Array.from({ length: 260 }, (_, i) => `C${i}`);
  let tokenCalls = 0;
  const admin = http.createServer(async (req, res) => {
    let body = ''; for await (const ch of req) body += ch;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/admin/oauth/access_token') { tokenCalls++; return res.end(JSON.stringify({ access_token: 'tok', expires_in: 86399 })); }
    if (req.headers['x-shopify-access-token'] !== 'tok') { res.statusCode = 401; return res.end('{}'); }
    const { query, variables } = JSON.parse(body);
    if (query.includes('shop {')) return res.end(JSON.stringify({ data: { shop: { name: 'Mock' } } }));
    if (query.includes('products(')) return res.end(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: false }, nodes: [{ handle: 'velvet-admin' }] } } }));
    const start = variables.after ? 250 : 0, end = Math.min(start + 250, colors.length);
    res.end(JSON.stringify({ data: { productByIdentifier: { title: 'Velvet (admin)', handle: 'velvet-admin', status: 'DRAFT', tags: TAGS, options: [{ name: 'Color' }],
      variants: { pageInfo: { hasNextPage: end < colors.length, endCursor: 'p2' },
        nodes: colors.slice(start, end).map((c, i) => ({ id: `gid://shopify/ProductVariant/${7000 + start + i}`, title: c, selectedOptions: [{ name: 'Color', value: c }] })) } } } }));
  }).listen(0);
  const adminBase = `http://127.0.0.1:${admin.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sofa3d-admin-'));
  const { app } = createApp({ DATA_DIR: dir, ADMIN_PASSWORD: 'secret', SHOPIFY_SHOP: adminBase, SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec' });
  const srv = app.listen(0);
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    const login = await fetch(b + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
    const ck = login.headers.get('set-cookie').split(';')[0];
    const j = (m, u, body) => fetch(b + u, { method: m, headers: { cookie: ck, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
    const st = await j('GET', '/api/shopify/status');
    assert.equal(st.connected, true); assert.equal(st.mode, 'client'); assert.equal(st.shopName, 'Mock');
    const t = await j('POST', '/api/products', { name: 'T' });
    const r = await j('POST', '/api/shopify/sync', { settings: { query: 'tag:"group:the-elevate-sofa"', templateId: t.id } });
    assert.equal(r.results[0].action, 'created', JSON.stringify(r));
    assert.equal(r.results[0].variants, 260, 'all variants beyond the first page');
    assert.equal(tokenCalls, 1, 'token cached');
  } finally { srv.close(); admin.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
