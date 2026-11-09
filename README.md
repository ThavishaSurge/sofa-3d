# Sofa 3D configurator

A 3D product viewer for Shopify. You upload a sofa model (.glb), fabric textures and colours, and map each **Shopify variant ID** to a combination such as Fabric × Colour × Size × Construction. Then you embed it on your product page with an iframe. When a shopper clicks a variant button in Shopify, the 3D model changes to match.

```
Shopify product page                         Railway (this app)
┌──────────────────────────────┐            ┌──────────────────────────────────┐
│ variant pickers  ──► embed.js│──iframe──► │ /embed/:id   three.js viewer      │
│ (input[name=id], ?variant=,  │ postMessage│ /api/public/* product config      │
│  properties[…])              │  setVariant│ /files/*     .glb + textures      │
└──────────────────────────────┘            │ /admin       upload & mapping UI  │
                                            │ SQLite + uploads on /data volume  │
                                            └──────────────────────────────────┘
```

## Features
- **Admin** (`/admin`, password protected): products, drag-and-drop uploads of .glb models (Draco/Meshopt compressed models are supported) and fabric images, and a live 3D preview.
- **Options & effects**: each option value (e.g. *Boucle*) can apply one or more effects:
  - **Fabric texture**: colour map, plus optional normal and roughness maps, tiling and roughness, applied to chosen materials or meshes
  - **Colour**: tints the chosen materials, so one neutral fabric scan can serve every colour
  - **Size**: scales the model along X/Y/Z
  - **Show/hide parts**: for constructions such as a left or right chaise, or arm styles
  - **Swap model**: a different .glb for constructions that change the shape
- **Variant mapping**: one row per combination with its Shopify variant ID. You can fill the table three ways:
  - **Import from Shopify**: enter the store domain and handle and it pulls every variant ID and option value, then auto-matches them. No token needed for published products.
  - **Generate all combinations**: then paste each variant ID into its row.
  - **Add rows manually.**
  Aliases handle spelling differences (e.g. "Sage Green" → *Sage*). Re-importing keeps your effects and any mappings you set by hand.
- **Embed**: one universal Liquid snippet that finds the product by handle, a per-product snippet, a plain iframe, and a JS API.
- **Duplicate** a product (e.g. when each construction is sold as a separate Shopify product).

## Run locally
```bash
npm install
npm run sample                     # generates sample/sofa.glb + fabric textures
ADMIN_PASSWORD=admin npm start     # http://localhost:3000/admin
npm run seed -- http://localhost:3000 admin   # creates a fully configured demo product (108 variants)
```
The seed script prints a link to a **mock Shopify product page** (`/demo/?product=ID`) where you can click variants and watch the 3D update.

## Deploy to Railway
1. Push this folder to a GitHub repo, then in Railway choose **New Project → Deploy from GitHub repo**. The `Dockerfile` and `railway.json` are picked up automatically.
2. **Add a volume** to the service, mounted at `/data`. The database and every uploaded model and texture live there. Without a volume they're lost on each deploy.
3. Set these variables:
   | Variable | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a strong password |
   | `SESSION_SECRET` | a random 32+ character string |
   | `FRAME_ANCESTORS` | `https://yourstore.com https://yourstore.myshopify.com https://admin.shopify.com` (or `*`) |
4. **Settings → Networking → Generate domain** (or add a custom one, e.g. `3d.yourstore.com`).
5. Open `https://<domain>/admin`.

Keep the service at **1 replica**: SQLite and the files live on a single volume.

## Put it on Shopify
See [`shopify/README.md`](shopify/README.md). In short, paste this once into the product template (e.g. a Custom Liquid block):
```liquid
<div data-sofa3d-handle="{{ product.handle }}" data-variant="{{ product.selected_or_first_available_variant.id }}" data-aspect="4/3"></div>
<script src="https://YOUR-APP.up.railway.app/embed.js" defer></script>
```

**Shopify's limits:** a product can have up to 2,048 variants but only **3 options**. For four options (Fabric, Colour, Size, Construction), see the workarounds in `shopify/README.md`.

## Preparing models (for your 3D artist)
- Export **glTF Binary (.glb)**, with Y up, in metres, and with the sofa standing on the ground at y = 0.
- Give every upholstered surface the **same material name** (e.g. `Fabric`), and give the legs a separate one (`Legs`). Those names are what the effects target.
- UV-unwrap the fabric at a **consistent texel density** so one tiling value fits every part. Seamless textures need no visible seams.
- Model optional parts (chaise, arm styles) as **named nodes** (`Chaise_L`, `Arm_Track`) so they can be shown or hidden.
- Keep the file under ~10 MB. Draco compression via `gltf-transform optimize` works well.
- Fabric textures: seamless, 1024–2048 px, JPG/WebP. For **colour tinting**, use a light, neutral (near-white) version of the fabric. A normal map makes boucle and velvet read much better.

## Embed parameters & API
`/embed/:id?variant=ID&ui=1&bg=ffffff&autorotate=1`

`embed.js` element attributes: `data-sofa3d` (product id) or `data-sofa3d-handle`, `data-variant`, `data-aspect`, `data-height`, `data-ui`, `data-bg`, `data-autorotate`, `data-form` (CSS selector of the product form).

```js
Sofa3D.setVariant('46123456789012');
Sofa3D.setOptions({ Fabric: 'Boucle', Colour: 'Sage' });
document.addEventListener('sofa3d:state', (e) => console.log(e.detail.state));
```
postMessage protocol (if you embed the iframe yourself): `sofa3d:setVariant {variantId, extraOptions?}`, `sofa3d:setOptions {options}`, and `sofa3d:resetCamera`. The iframe replies with `sofa3d:ready`, `sofa3d:state` and `sofa3d:unmatched`.

## Tests
```bash
npm test                          # API tests (auth, uploads, Shopify import, mapping rules, duplicate, XSS)
# Browser end-to-end (Python Playwright + Chrome), with the server running:
python3 -m http.server 4001 --directory public/demo &
python3 test/e2e/manual_mapping.py http://localhost:3000 <password>
python3 test/e2e/shopify_bridge.py <demo-product-id>
```

## Project layout
```
src/server.js          Express app: admin API, public API, iframe page, static files
src/db.js              SQLite schema
src/shopify.js         Shopify import + auto-mapping
public/viewer/         three.js viewer (iframe)
public/embed.js        script your Shopify theme loads
public/admin/          admin UI (no build step)
public/demo/           mock Shopify product page for testing
shopify/               Liquid snippet + theme app extension (optional Shopify app)
scripts/               sample asset generator, demo seeder
```
