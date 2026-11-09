// Import product variants from Shopify.
// 1) If the Admin API is configured (SHOPIFY_SHOP + SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET)
//    and the shop matches -> Admin GraphQL API (works for drafts, reads every variant, read_products scope only)
// 2) Otherwise the public storefront endpoint https://{shop}/products/{handle}.js (no token needed)
import { newId } from './db.js';

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function shopBase(shopDomain) {
  let d = String(shopDomain || '').trim().replace(/\/+$/, '');
  if (!d) throw new Error('Shop domain is required');
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
  return d;
}

/** Normalize to {title, handle, options:[name], variants:[{id,title,options:[values]}]} */
export function normalizeShopifyProduct(p) {
  if (!p || typeof p !== 'object') throw new Error('Invalid product JSON');
  if (p.product) p = p.product; // /products/handle.json format
  const optionNames = (p.options || []).map((o) => (typeof o === 'string' ? o : o.name));
  const variants = (p.variants || []).map((v) => {
    const opts = v.options || [v.option1, v.option2, v.option3].filter((x) => x != null);
    return { id: String(v.id), title: v.title || opts.join(' / '), options: opts.map(String) };
  });
  if (!variants.length) throw new Error('No variants found in product JSON');
  return { title: p.title, handle: p.handle, options: optionNames, variants, tags: splitTags(p.tags) };
}

const splitTags = (t) => (Array.isArray(t) ? t : String(t || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

const API_VERSION = (env) => env.SHOPIFY_API_VERSION || '2026-01';
const shopHost = (shop) => norm(shop).replace(/^https?:\/\//, '').replace(/\/+$/, '');
const tokenCache = new Map();

export function adminMode(env = process.env) {
  if (!env.SHOPIFY_SHOP) return null;
  if (env.SHOPIFY_ADMIN_TOKEN) return 'token';
  if (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) return 'client';
  return null;
}

// Static Admin token, or a short-lived one from the client-credentials grant (Dev Dashboard apps).
async function adminToken(env) {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  const key = env.SHOPIFY_SHOP + '|' + env.SHOPIFY_CLIENT_ID;
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.token;
  const res = await fetch(`${shopBase(env.SHOPIFY_SHOP)}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }),
  });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  if (!res.ok || !json.access_token) {
    // Shopify's reason, e.g. shop_not_permitted / invalid_client – never includes our secret
    const why = [json.error, json.error_description, json.errors].flat().filter(Boolean).map(String).join(': ') || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`Shopify token request failed (HTTP ${res.status})${why ? ' – ' + why : ''}`);
  }
  tokenCache.set(key, { token: json.access_token, exp: Date.now() + ((json.expires_in || 3600) - 120) * 1000 });
  return json.access_token;
}

export async function adminGraphql(env, query, variables = {}) {
  const res = await fetch(`${shopBase(env.SHOPIFY_SHOP)}/admin/api/${API_VERSION(env)}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await adminToken(env) },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify Admin API error ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error('Shopify Admin API: ' + json.errors.map((e) => e.message).join('; '));
  return json.data;
}

async function fetchAdmin(env, handle) {
  const query = `query($h:String!,$after:String){ productByIdentifier(identifier:{handle:$h}){ title handle status tags options{name}
    variants(first:250, after:$after){ pageInfo{hasNextPage endCursor} nodes{ id title selectedOptions{name value} } } } }`;
  let p = null, after = null;
  const nodes = [];
  do {
    const d = await adminGraphql(env, query, { h: handle, after });
    p = d?.productByIdentifier;
    if (!p) throw new Error(`Product "${handle}" not found via Admin API`);
    nodes.push(...p.variants.nodes);
    after = p.variants.pageInfo.hasNextPage ? p.variants.pageInfo.endCursor : null;
  } while (after);
  return {
    title: p.title,
    handle: p.handle,
    status: p.status,
    tags: p.tags || [],
    options: p.options.map((o) => o.name),
    variants: nodes.map((v) => ({
      id: v.id.split('/').pop(),
      title: v.title,
      options: v.selectedOptions.map((s) => s.value),
    })),
  };
}

/** Handles of every product matching a Shopify search query, e.g. tag:"group:the-elevate-sofa". */
export async function searchAdminHandles(env, search) {
  const query = `query($q:String,$after:String){ products(first:100, query:$q, after:$after){ pageInfo{hasNextPage endCursor} nodes{ handle } } }`;
  const out = [];
  let after = null;
  do {
    const d = await adminGraphql(env, query, { q: search || null, after });
    out.push(...d.products.nodes.map((n) => n.handle));
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after && out.length < 2000);
  return out;
}

export async function fetchShopifyProduct(shopDomain, handle, env = process.env) {
  if (!handle) throw new Error('Product handle is required');
  if (adminMode(env) && (!shopDomain || shopHost(shopDomain) === shopHost(env.SHOPIFY_SHOP) || shopHost(shopDomain) === shopHost(env.SHOPIFY_STORE_DOMAIN || ''))) {
    return fetchAdmin(env, handle);
  }
  const res = await fetch(`${shopBase(shopDomain)}/products/${encodeURIComponent(handle)}.js`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Could not fetch ${handle} from ${shopDomain} (HTTP ${res.status}). Is the product published?`);
  return normalizeShopifyProduct(await res.json());
}

function findValue(option, valueName) {
  const n = norm(valueName);
  return option.values.find((v) => norm(v.name) === n || (v.aliases || []).some((a) => norm(a) === n));
}

/**
 * Merge imported Shopify data into a configurator config.
 * - creates any missing options/values (no effects yet)
 * - replaces the variant list, auto-mapping selections by option/value name
 * - keeps manual mappings for variant ids that already existed
 */
/**
 * Options the configurator has but this Shopify product doesn't (e.g. one product per fabric/size)
 * are fixed from the product's tags: a value is picked when every part of its name is a tag value,
 * so '96" - Natural' matches tags size:96" + construction:Natural, and 'Cactus Leather' matches fabric:Cactus Leather.
 */
export function fixedFromTags(cfg, sp) {
  const vals = new Set();
  for (const t of sp.tags || []) { vals.add(norm(t)); const i = t.indexOf(':'); if (i > 0) vals.add(norm(t.slice(i + 1))); }
  const fixed = {};
  const own = new Set((sp.options || []).map(norm));
  for (const opt of cfg.options) {
    if (own.has(norm(opt.name))) continue;
    let best = null, score = 0;
    for (const v of opt.values) {
      for (const name of [v.name, ...(v.aliases || [])]) {
        const parts = String(name).split(/\s+[-\/|]\s+|\s*,\s*/).map(norm).filter(Boolean);
        if (parts.length > score && parts.every((x) => vals.has(x))) { best = v; score = parts.length; }
      }
    }
    if (best) fixed[opt.id] = best.id;
  }
  return fixed;
}

export function mergeShopifyIntoConfig(config, sp) {
  const cfg = structuredClone(config);
  const prevVariants = new Map((cfg.variants || []).map((v) => [v.id, v]));
  sp.options.forEach((optName, idx) => {
    let opt = cfg.options.find((o) => norm(o.name) === norm(optName));
    if (!opt) {
      opt = { id: newId(6), name: optName, values: [] };
      cfg.options.push(opt);
    }
    for (const v of sp.variants) {
      const val = v.options[idx];
      if (val != null && !findValue(opt, val)) {
        opt.values.push({ id: newId(6), name: val, aliases: [], effects: [] });
      }
    }
  });
  const fixed = fixedFromTags(cfg, sp);
  cfg.variants = sp.variants.map((v) => {
    const selections = {};
    sp.options.forEach((optName, idx) => {
      const opt = cfg.options.find((o) => norm(o.name) === norm(optName));
      const val = opt && findValue(opt, v.options[idx]);
      if (opt && val) selections[opt.id] = val.id;
    });
    const prev = prevVariants.get(v.id);
    return { id: v.id, title: v.title, options: v.options, selections: { ...fixed, ...selections, ...(prev?.manual ? prev.selections : {}) }, manual: prev?.manual || false };
  });
  cfg.shopify = { ...(cfg.shopify || {}), handle: sp.handle || cfg.shopify?.handle || '', fixed };
  // default selection = first variant
  if (cfg.variants[0] && !Object.keys(cfg.defaults || {}).length) cfg.defaults = { ...cfg.variants[0].selections };
  else cfg.defaults = { ...(cfg.defaults || {}), ...fixed };
  return cfg;
}
