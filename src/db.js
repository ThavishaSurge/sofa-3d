import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'sofa3d.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      shopify_handle TEXT,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_products_handle ON products(shopify_handle);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,           -- model | texture
      name TEXT NOT NULL,           -- original file name
      file TEXT NOT NULL,           -- stored file name (relative to product dir)
      mime TEXT,
      size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_assets_product ON assets(product_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function newId(len = 10) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function emptyConfig() {
  return {
    modelAssetId: null,
    viewer: { background: 'transparent', autoRotate: false, exposure: 1, showFloorShadow: true },
    shopify: { shopDomain: '', handle: '' },
    options: [],   // [{id,name,values:[{id,name,aliases:[],swatch,effects:[]}]}]
    variants: [],  // [{id,title,options:[...], selections:{optionId:valueId}}]
    defaults: {},  // {optionId: valueId}
  };
}
