// Creates a fully configured demo product through the HTTP API.
// usage: node scripts/seed-demo.js [baseUrl] [password]
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = process.argv[3] || process.env.ADMIN_PASSWORD || 'admin';
const SAMPLE = path.resolve(process.env.SAMPLE_DIR || "sample");

let cookie = '';
async function api(method, url, body) {
  const opts = { method, headers: { cookie } };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + url, opts);
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url}: ${json.error}`);
  return json;
}

export const DEMO_OPTIONS = {
  Fabric: ['Linen', 'Velvet', 'Boucle'],
  Colour: ['Oat', 'Sage', 'Charcoal', 'Terracotta'],
  Size: ['2 Seater', '3 Seater', '4 Seater'],
  Construction: ['Standard', 'Chaise Left', 'Chaise Right'],
};
export function fakeShopifyProduct(handle = 'oslo-sofa') {
  const names = Object.keys(DEMO_OPTIONS);
  const variants = [];
  let n = 0;
  const rec = (i, acc) => {
    if (i === names.length) { variants.push({ id: 46000000000000 + n++, title: acc.join(' / '), options: acc }); return; }
    for (const v of DEMO_OPTIONS[names[i]]) rec(i + 1, [...acc, v]);
  };
  rec(0, []);
  return { title: 'Oslo Sofa', handle, options: names.map((name, i) => ({ name, position: i + 1, values: DEMO_OPTIONS[name] })), variants };
}

export async function seed() {
  await api('POST', '/api/login', { password: PASSWORD });
  const p = await api('POST', '/api/products', { name: 'Oslo Sofa (demo)' });
  const fd = new FormData();
  for (const f of ['sofa.glb', 'linen.png', 'velvet.png', 'boucle.png', 'boucle_normal.png']) {
    fd.append('files', new Blob([fs.readFileSync(path.join(SAMPLE, f))]), f);
  }
  const up = await api('POST', `/api/products/${p.id}/assets`, fd);
  const A = Object.fromEntries(up.assets.map((a) => [a.name, a.id]));

  const val = (name, effects, aliases = []) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, aliases, effects });
  const config = {
    ...up.config,
    shopify: { shopDomain: '', handle: '' },
    options: [
      { id: 'fabric', name: 'Fabric', values: [
        val('Linen', [{ type: 'texture', targets: ['Fabric'], map: A['linen.png'], repeat: 2, roughness: 0.95 }]),
        val('Velvet', [{ type: 'texture', targets: ['Fabric'], map: A['velvet.png'], repeat: 1, roughness: 0.55 }]),
        val('Boucle', [{ type: 'texture', targets: ['Fabric'], map: A['boucle.png'], normalMap: A['boucle_normal.png'], repeat: 1.5, roughness: 1 }]),
      ] },
      { id: 'colour', name: 'Colour', values: [
        val('Oat', [{ type: 'color', targets: ['Fabric'], color: '#e3d6bf' }]),
        val('Sage', [{ type: 'color', targets: ['Fabric'], color: '#9fae93' }], ['Sage Green']),
        val('Charcoal', [{ type: 'color', targets: ['Fabric'], color: '#4a4a4c' }]),
        val('Terracotta', [{ type: 'color', targets: ['Fabric'], color: '#c0714f' }]),
      ] },
      { id: 'size', name: 'Size', values: [
        val('2 Seater', [{ type: 'scale', scale: [0.8, 1, 1] }]),
        val('3 Seater', [{ type: 'scale', scale: [1, 1, 1] }]),
        val('4 Seater', [{ type: 'scale', scale: [1.25, 1, 1] }]),
      ] },
      { id: 'construction', name: 'Construction', values: [
        val('Standard', [{ type: 'visibility', show: [], hide: ['Chaise_L', 'Chaise_R'] }]),
        val('Chaise Left', [{ type: 'visibility', show: ['Chaise_L'], hide: ['Chaise_R'] }]),
        val('Chaise Right', [{ type: 'visibility', show: ['Chaise_R'], hide: ['Chaise_L'] }]),
      ] },
    ],
    defaults: { fabric: 'linen', colour: 'oat', size: '3-seater', construction: 'standard' },
  };
  await api('PUT', `/api/products/${p.id}`, { name: p.name, config });
  const imp = await api('POST', `/api/products/${p.id}/import-variants`, { productJson: fakeShopifyProduct() });
  return { id: p.id, imported: imp.imported, config: imp.config };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const r = await seed();
  console.log(`Demo product ${r.id}: ${r.imported.variants} variants imported (${r.imported.options.join(', ')})`);
  console.log(`Admin:  ${BASE}/admin/#/p/${r.id}`);
  console.log(`Viewer: ${BASE}/embed/${r.id}?ui=1`);
  console.log(`Mock Shopify page: ${BASE}/demo/?product=${r.id}`);
}
