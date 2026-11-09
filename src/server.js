import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, newId, emptyConfig } from './db.js';
import { fetchShopifyProduct, normalizeShopifyProduct, mergeShopifyIntoConfig, norm, adminMode, adminGraphql, searchAdminHandles,
  authorizeUrl, validCallbackHmac, sameShop, exchangeCode } from './shopify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function createApp(env = process.env) {
  const DATA_DIR = path.resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data'));
  const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(path.join(UPLOAD_DIR, 'tmp'), { recursive: true });
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'admin';
  if (!env.ADMIN_PASSWORD) console.warn('[sofa3d] ADMIN_PASSWORD not set – using "admin". Set it before deploying!');
  const SECRET = env.SESSION_SECRET || crypto.createHash('sha256').update('sofa3d:' + ADMIN_PASSWORD).digest('hex');
  const FRAME_ANCESTORS = (env.FRAME_ANCESTORS || '*').trim();
  const MAX_MODEL_MB = Number(env.MAX_MODEL_MB || 100);

  const db = openDb(DATA_DIR);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  // ---------- helpers ----------
  const getProduct = (id) => {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, config: { ...emptyConfig(), ...JSON.parse(row.config || '{}') } };
  };
  const getAssets = (productId) =>
    db.prepare('SELECT * FROM assets WHERE product_id = ? ORDER BY created_at').all(productId);
  const assetUrl = (a) => `/files/${a.id}/${encodeURIComponent(a.name)}`;
  const assetDto = (a) => ({ id: a.id, kind: a.kind, name: a.name, size: a.size, url: assetUrl(a) });
  const saveProduct = (id, name, config) => {
    db.prepare(`UPDATE products SET name = ?, shopify_handle = ?, config = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, norm(config.shopify?.handle) || null, JSON.stringify(config), id);
  };

  function sign(payload) {
    return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  }
  function makeSession() {
    const exp = Date.now() + 1000 * 60 * 60 * 24 * 14;
    return `${exp}.${sign(String(exp))}`;
  }
  function validSession(tok) {
    if (!tok || typeof tok !== 'string') return false;
    const [exp, sig] = tok.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const expected = sign(exp);
    return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }
  const requireAuth = (req, res, next) =>
    validSession(req.cookies.sofa3d_session) ? next() : res.status(401).json({ error: 'Not logged in' });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- health ----------
  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---------- auth ----------
  app.post('/api/login', (req, res) => {
    const pw = String(req.body?.password || '');
    const a = crypto.createHash('sha256').update(pw).digest();
    const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong password' });
    res.cookie('sofa3d_session', makeSession(), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 1000 * 60 * 60 * 24 * 14,
    });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { res.clearCookie('sofa3d_session'); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json({ loggedIn: validSession(req.cookies.sofa3d_session) }));

  // Read-only storage report – where data lives and what's in it (for diagnosing missing products)
  app.get('/api/storage', requireAuth, (req, res) => {
    const size = (f) => { try { return fs.statSync(f).size; } catch { return null; } };
    const dirs = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).filter((d) => d !== 'tmp') : [];
    const ids = new Set(db.prepare('SELECT id FROM products').all().map((r) => r.id));
    res.json({
      dataDir: DATA_DIR, files: fs.readdirSync(DATA_DIR),
      db: { size: size(path.join(DATA_DIR, 'sofa3d.db')), wal: size(path.join(DATA_DIR, 'sofa3d.db-wal')), products: ids.size, assets: db.prepare('SELECT COUNT(*) n FROM assets').get().n },
      uploadDirs: dirs.map((d) => ({ dir: d, files: fs.readdirSync(path.join(UPLOAD_DIR, d)).length, inDb: ids.has(d) })),
    });
  });

  // ---------- admin API ----------
  app.get('/api/products', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, name, shopify_handle, config, updated_at FROM products ORDER BY updated_at DESC').all();
    res.json(rows.map((r) => {
      const c = JSON.parse(r.config || '{}');
      return { id: r.id, name: r.name, handle: r.shopify_handle, updatedAt: r.updated_at,
        hasModel: !!c.modelAssetId, options: (c.options || []).length, variants: (c.variants || []).length };
    }));
  });

  app.post('/api/products', requireAuth, (req, res) => {
    const id = newId();
    const name = String(req.body?.name || 'Untitled sofa').slice(0, 200);
    const config = emptyConfig();
    db.prepare('INSERT INTO products (id, name, config) VALUES (?, ?, ?)').run(id, name, JSON.stringify(config));
    res.status(201).json({ id, name, config, assets: [] });
  });

  app.get('/api/products/:id', requireAuth, (req, res) => {
    const p = getProduct(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json({ id: p.id, name: p.name, config: p.config, assets: getAssets(p.id).map(assetDto) });
  });

  app.put('/api/products/:id', requireAuth, (req, res) => {
    const p = getProduct(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const name = String(req.body?.name ?? p.name).slice(0, 200);
    const config = { ...emptyConfig(), ...(req.body?.config || p.config) };
    const ids = (config.variants || []).map((v) => String(v.id || '').trim()).filter(Boolean);
    const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupe) return res.status(400).json({ error: `Variant ID ${dupe} is used on more than one row` });
    if (config.shopify?.handle) {
      const clash = db.prepare('SELECT id, name FROM products WHERE shopify_handle = ? AND id != ?').get(norm(config.shopify.handle), p.id);
      if (clash) return res.status(409).json({ error: `Shopify handle already used by "${clash.name}"` });
    }
    saveProduct(p.id, name, config);
    res.json({ id: p.id, name, config, assets: getAssets(p.id).map(assetDto) });
  });

  function duplicateProduct(p, name) {
    const id = newId();
    const dir = path.join(UPLOAD_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    let json = JSON.stringify({ ...p.config, shopify: { ...p.config.shopify, handle: '', fixed: {} }, variants: [] });
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO products (id, name, config) VALUES (?, ?, ?)').run(id, String(name || p.name + ' (copy)').slice(0, 200), '{}');
      for (const a of getAssets(p.id)) {
        const nid = newId(12);
        const file = nid + path.extname(a.file);
        fs.copyFileSync(path.join(UPLOAD_DIR, p.id, a.file), path.join(dir, file));
        db.prepare('INSERT INTO assets (id, product_id, kind, name, file, mime, size) VALUES (?,?,?,?,?,?,?)').run(nid, id, a.kind, a.name, file, a.mime, a.size);
        json = json.split(`"${a.id}"`).join(`"${nid}"`);
      }
      db.prepare('UPDATE products SET config = ? WHERE id = ?').run(json, id);
    });
    tx();
    return id;
  }

  app.post('/api/products/:id/duplicate', requireAuth, (req, res) => {
    const p = getProduct(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ id: duplicateProduct(p, req.body?.name) });
  });

  app.delete('/api/products/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    fs.rmSync(path.join(UPLOAD_DIR, req.params.id.replace(/[^a-z0-9]/gi, '')), { recursive: true, force: true });
    res.json({ ok: true });
  });

  const upload = multer({ dest: path.join(UPLOAD_DIR, 'tmp'), limits: { fileSize: MAX_MODEL_MB * 1024 * 1024 } });
  const MODEL_EXT = ['.glb'];
  const TEX_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
  const MIME = { '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

  app.post('/api/products/:id/assets', requireAuth, upload.array('files', 50), (req, res) => {
    const p = getProduct(req.params.id);
    const files = req.files || [];
    const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
    if (!p) { cleanup(); return res.status(404).json({ error: 'Not found' }); }
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
    const dir = path.join(UPLOAD_DIR, p.id);
    fs.mkdirSync(dir, { recursive: true });
    const created = [];
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      const kind = MODEL_EXT.includes(ext) ? 'model' : TEX_EXT.includes(ext) ? 'texture' : null;
      if (!kind) { fs.rmSync(f.path, { force: true }); continue; }
      const id = newId(12);
      const file = id + ext;
      fs.renameSync(f.path, path.join(dir, file));
      const name = path.basename(f.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
      db.prepare('INSERT INTO assets (id, product_id, kind, name, file, mime, size) VALUES (?,?,?,?,?,?,?)')
        .run(id, p.id, kind, name, file, MIME[ext], f.size);
      created.push(db.prepare('SELECT * FROM assets WHERE id = ?').get(id));
    }
    if (!created.length) return res.status(400).json({ error: 'Unsupported file type. Use .glb for models and .jpg/.png/.webp for textures.' });
    // First model uploaded becomes the main model automatically.
    const firstModel = created.find((a) => a.kind === 'model');
    if (firstModel && !p.config.modelAssetId) {
      p.config.modelAssetId = firstModel.id;
      saveProduct(p.id, p.name, p.config);
    }
    res.status(201).json({ assets: created.map(assetDto), config: getProduct(p.id).config });
  });

  app.delete('/api/products/:id/assets/:assetId', requireAuth, (req, res) => {
    const a = db.prepare('SELECT * FROM assets WHERE id = ? AND product_id = ?').get(req.params.assetId, req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
    fs.rmSync(path.join(UPLOAD_DIR, a.product_id, a.file), { force: true });
    const p = getProduct(req.params.id);
    if (p.config.modelAssetId === a.id) { p.config.modelAssetId = null; saveProduct(p.id, p.name, p.config); }
    res.json({ ok: true, config: getProduct(req.params.id).config });
  });

  app.post('/api/products/:id/import-variants', requireAuth, wrap(async (req, res) => {
    const p = getProduct(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    let sp;
    try {
      if (req.body?.productJson) {
        const raw = typeof req.body.productJson === 'string' ? JSON.parse(req.body.productJson) : req.body.productJson;
        sp = normalizeShopifyProduct(raw);
      } else {
        sp = await fetchShopifyProduct(req.body?.shopDomain || p.config.shopify?.shopDomain, req.body?.handle || p.config.shopify?.handle, shopEnv());
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const config = mergeShopifyIntoConfig(p.config, sp);
    if (req.body?.shopDomain) config.shopify.shopDomain = req.body.shopDomain;
    const clash = config.shopify.handle &&
      db.prepare('SELECT name FROM products WHERE shopify_handle = ? AND id != ?').get(norm(config.shopify.handle), p.id);
    if (clash) return res.status(409).json({ error: `Shopify handle already used by "${clash.name}"` });
    saveProduct(p.id, p.name, config);
    res.json({ config, imported: { title: sp.title, options: sp.options, variants: sp.variants.length } });
  }));

  // ---------- Shopify sync ----------
  // Creates a 3D product (copied from a fully set-up template) for every matching Shopify product,
  // or refreshes the variants of one that already exists. Read-only towards Shopify.
  const SYNC_DEFAULTS = { shopDomain: '', query: '', handles: '', templateId: '', autoSync: false, lastRun: null };
  const getSettings = () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sync'").get();
    return { ...SYNC_DEFAULTS, ...(row ? JSON.parse(row.value) : {}) };
  };
  const putSettings = (s) => db.prepare("INSERT INTO settings (key, value) VALUES ('sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));

  // Option values the product actually uses that have no effect yet – these need a human.
  function unfilled(config) {
    const used = new Set(config.variants.flatMap((v) => Object.values(v.selections || {})));
    return config.options.flatMap((o) => o.values.filter((v) => used.has(v.id) && !(v.effects || []).length).map((v) => `${o.name}: ${v.name}`));
  }
  const unmapped = (config) => config.variants.filter((v) => config.options.some((o) => !v.selections?.[o.id])).map((v) => v.title);

  async function runSync(opts, { dryRun = false } = {}) {
    const s = { ...getSettings(), ...opts };
    const template = s.templateId && getProduct(s.templateId);
    let handles = String(s.handles || '').split(/[\s,]+/).map((x) => x.trim().replace(/^.*\/products\//, '').replace(/[?#].*$/, '')).filter(Boolean);
    if (s.query) {
      if (!adminMode(shopEnv())) throw new Error('A search query needs the Shopify Admin API – set SHOPIFY_SHOP and a token on the server, or list handles instead');
      handles = [...new Set([...handles, ...await searchAdminHandles(shopEnv(), s.query)])];
    }
    if (!handles.length) throw new Error('Nothing to sync – enter a search query or product handles');
    const results = [];
    for (const handle of handles) {
      const r = { handle };
      try {
        const sp = await fetchShopifyProduct(s.shopDomain || env.SHOPIFY_SHOP, handle, shopEnv());
        const row = db.prepare('SELECT id FROM products WHERE shopify_handle = ?').get(norm(sp.handle || handle));
        let p = row && getProduct(row.id);
        r.title = sp.title; r.status = sp.status; r.variants = sp.variants.length;
        if (!p && !template) throw new Error('Not in the app yet and no template product chosen');
        r.action = p ? 'updated' : 'created';
        const base = p ? p.config : { ...template.config, shopify: { ...template.config.shopify, handle: '', fixed: {} }, variants: [] };
        const config = mergeShopifyIntoConfig(base, sp);
        if (s.shopDomain) config.shopify.shopDomain = s.shopDomain;
        r.fixed = Object.entries(config.shopify.fixed || {}).map(([oid, vid]) => {
          const o = config.options.find((x) => x.id === oid);
          return `${o?.name}: ${o?.values.find((v) => v.id === vid)?.name}`;
        });
        r.unfilled = unfilled(config);
        r.unmapped = unmapped(config).length;
        if (!dryRun) {
          // a new product is copied from the template first; the copy has new asset ids, so merge into the copy
          if (!p) p = getProduct(duplicateProduct(template, sp.title));
          const final = row ? config : mergeShopifyIntoConfig(p.config, sp);
          if (s.shopDomain) final.shopify.shopDomain = s.shopDomain;
          saveProduct(p.id, p.name, final);
          r.id = p.id;
        }
      } catch (e) { r.action = 'error'; r.error = e.message; }
      results.push(r);
    }
    if (!dryRun) putSettings({ ...getSettings(), lastRun: { at: new Date().toISOString(), ok: results.filter((x) => x.action !== 'error').length, errors: results.filter((x) => x.action === 'error').length } });
    return results;
  }

  // Token saved by the "Connect store" install; env vars always win.
  const storedToken = () => { const r = db.prepare("SELECT value FROM settings WHERE key = 'shopify_token'").get(); return r ? JSON.parse(r.value) : null; };
  const shopEnv = () => {
    const t = storedToken();
    return t && sameShop(t.shop, env.SHOPIFY_SHOP) ? { ...env, SHOPIFY_OAUTH_TOKEN: t.token } : env;
  };

  app.get('/api/shopify/install', requireAuth, (req, res) => {
    if (!(env.SHOPIFY_SHOP && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)) return res.status(400).send('Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET on the server first.');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('sofa3d_oauth', state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000 });
    res.redirect(authorizeUrl(env, { redirectUri: `${env.APP_URL || `${req.protocol}://${req.get('host')}`}/api/shopify/callback`, state }));
  });

  app.get('/api/shopify/callback', requireAuth, wrap(async (req, res) => {
    const q = req.query;
    const fail = (msg) => res.status(400).type('html').send(`<p style="font-family:sans-serif">Could not connect Shopify: ${msg.replace(/[<>&]/g, '')}. <a href="/admin/#/shopify">Back</a></p>`);
    const state = req.cookies.sofa3d_oauth;
    res.clearCookie('sofa3d_oauth');
    if (!state || q.state !== state) return fail('the sign-in expired or did not start here – try Connect store again');
    if (!validCallbackHmac(q, env.SHOPIFY_CLIENT_SECRET)) return fail('Shopify signature check failed');
    if (!sameShop(q.shop, env.SHOPIFY_SHOP)) return fail(`this server is set up for ${env.SHOPIFY_SHOP}, not ${q.shop}`);
    if (!q.code) return fail('no authorization code');
    let t;
    try { t = await exchangeCode(env, String(q.code)); } catch (e) { return fail(e.message); }
    db.prepare("INSERT INTO settings (key, value) VALUES ('shopify_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ token: t.token, scope: t.scope, shop: env.SHOPIFY_SHOP, at: new Date().toISOString() }));
    res.redirect('/admin/#/shopify');
  }));

  app.delete('/api/shopify/token', requireAuth, (req, res) => {
    db.prepare("DELETE FROM settings WHERE key = 'shopify_token'").run();
    res.json({ ok: true });
  });

  app.get('/api/shopify/status', requireAuth, wrap(async (req, res) => {
    const senv = shopEnv();
    const mode = adminMode(senv);
    const out = { mode, shop: env.SHOPIFY_SHOP || null, settings: getSettings(),
      canInstall: !!(env.SHOPIFY_SHOP && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET), installedAt: storedToken()?.at || null };
    if (mode) {
      try { out.shopName = (await adminGraphql(senv, '{ shop { name } }')).shop.name; out.connected = true; }
      catch (e) { out.connected = false; out.error = e.message; }
    }
    res.json(out);
  }));
  app.put('/api/shopify/settings', requireAuth, (req, res) => {
    const b = req.body || {};
    const s = { ...getSettings(), shopDomain: String(b.shopDomain ?? '').trim(), query: String(b.query ?? '').trim(),
      handles: String(b.handles ?? ''), templateId: String(b.templateId ?? ''), autoSync: !!b.autoSync };
    putSettings(s);
    res.json(s);
  });
  app.post('/api/shopify/sync', requireAuth, wrap(async (req, res) => {
    try { res.json({ results: await runSync(req.body?.settings || {}, { dryRun: !!req.body?.dryRun }) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // Background sync (only when switched on in the admin and the Admin API is connected)
  async function autoSync() {
    const s = getSettings();
    if (!s.autoSync) return;
    try { const r = await runSync({}); console.log(`[sofa3d] auto-sync: ${r.length} product(s)`); }
    catch (e) { console.warn('[sofa3d] auto-sync failed:', e.message); }
  }

  // ---------- public API (used by the iframe) ----------
  const cors = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); };

  function publicConfig(p) {
    const assets = {};
    for (const a of getAssets(p.id)) assets[a.id] = { kind: a.kind, name: a.name, url: assetUrl(a) };
    const { variants, ...rest } = p.config;
    return {
      id: p.id, name: p.name, ...rest, assets,
      variants: (variants || []).map((v) => ({ id: v.id, title: v.title, selections: v.selections })),
    };
  }

  app.get('/api/public/products/:id', cors, (req, res) => {
    const p = getProduct(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'public, max-age=30');
    res.json(publicConfig(p));
  });

  app.get('/api/public/lookup', cors, (req, res) => {
    const handle = norm(req.query.handle);
    const row = handle && db.prepare('SELECT id FROM products WHERE shopify_handle = ?').get(handle);
    res.set('Cache-Control', 'public, max-age=60');
    if (!row) return res.status(404).json({ error: 'No 3D configurator for this product' });
    res.json({ id: row.id });
  });

  app.get('/files/:assetId{/:name}', cors, (req, res) => {
    const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.assetId);
    if (!a) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(a.mime || 'application/octet-stream');
    res.sendFile(path.join(UPLOAD_DIR, a.product_id, a.file));
  });

  // ---------- iframe page ----------
  const frameHeaders = (req, res, next) => {
    const anc = FRAME_ANCESTORS === '*' ? '*' : FRAME_ANCESTORS.split(/[\s,]+/).join(' ');
    res.set('Content-Security-Policy', `frame-ancestors ${anc}`);
    next();
  };
  const embedHtml = fs.readFileSync(path.join(ROOT, 'public/viewer/embed.html'), 'utf8');
  app.get('/embed/:id', frameHeaders, (req, res) => {
    const p = getProduct(req.params.id);
    if (!p) return res.status(404).type('html').send('<p style="font-family:sans-serif">3D model not found</p>');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(embedHtml
      .replace('__TITLE__', () => p.name.replace(/[<>&"]/g, ''))
      .replace('__CONFIG__', () => JSON.stringify(publicConfig(p)).replace(/</g, '\\u003c')));
  });

  // Script the Shopify theme loads to create the iframe + sync variants
  app.get('/embed.js', cors, (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.type('application/javascript').sendFile(path.join(ROOT, 'public/embed.js'));
  });

  // ---------- static ----------
  app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules/three'), { maxAge: '7d' }));
  app.use('/viewer', express.static(path.join(ROOT, 'public/viewer'), { maxAge: '5m' }));
  app.use('/admin', express.static(path.join(ROOT, 'public/admin'), { maxAge: 0 }));
  app.use('/demo', express.static(path.join(ROOT, 'public/demo'), { maxAge: 0 }));
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  return { app, db, autoSync };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, autoSync } = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`[sofa3d] listening on http://localhost:${port}`));
  const every = Number(process.env.SYNC_INTERVAL_MIN || 60);
  if (every > 0) setInterval(autoSync, every * 60 * 1000).unref();
}
