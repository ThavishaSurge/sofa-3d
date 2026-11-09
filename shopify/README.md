# Shopify integration

There are two ways to put the 3D viewer on your product pages. **Start with option A.** It needs no Shopify app and works on any Online Store 2.0 theme (Dawn, Sense, Refresh, etc.).

## A. Theme snippet (recommended to start)

1. In Shopify admin, go to **Online Store → Themes → ⋯ → Edit code**.
2. Under **Snippets**, add `sofa-3d.liquid` with the contents of `snippets/sofa-3d.liquid`. Change `APP_URL` to your Railway URL.
3. Open the product template in the theme editor and add a **Custom Liquid** block where the gallery is:
   ```liquid
   {% render 'sofa-3d', product: product %}
   ```
   (Or put the same line in `sections/main-product.liquid` above the media gallery.)
4. In the Sofa 3D admin, set each product's **Shopify handle** (the import does this for you).

That one snippet covers every product. Products with a configurator show the 3D viewer; products without one render nothing.

### How variant changes are picked up
`embed.js` watches all of these, so it works with most themes without changes:
- the product form's hidden `input[name="id"]` (Dawn and most themes)
- `?variant=` in the URL (`history.replaceState`/`pushState`)
- `change` events and the `variant:change` event
- `properties[...]` fields from options apps (for a 4th option such as Construction)
- a 500 ms poll as a safety net for themes that rebuild the form with AJAX

For a custom picker, call `Sofa3D.setVariant(id)` or `Sofa3D.setOptions({ Fabric: 'Boucle' })` directly.

### Shopify's 3-option limit
A Shopify product can have up to **2,048 variants but only 3 options**. For Fabric + Colour + Size + Construction, choose one of these:

| Approach | How to set it up in Sofa 3D |
|---|---|
| Combine Fabric and Colour into one option ("Boucle – Sage") | Give each combined value a **texture** effect and a **colour** effect. |
| Sell each construction as its own product | Build one product, then use **Duplicate** in the admin. Set the new handle and import its variants. |
| Construction comes from an options app (line item property) | Add a configurator option named exactly like the property (e.g. `Construction`). The bridge reads `properties[Construction]` automatically. |

## B. Shopify app with a theme app block (optional, Phase 2)

Build this when you want staff to drag the viewer in from the theme editor, or if you plan to use it on more than one store. `theme-app-extension/` already contains the block:

```bash
npm init @shopify/app@latest        # choose "Build an extension-only app"
cd your-app
mkdir -p extensions/sofa-3d && cp -r /path/to/sofa3d/shopify/theme-app-extension/* extensions/sofa-3d/
shopify app deploy
```
Then install the app on your store. In the theme editor, open the product template → **Add block → Apps → 3D sofa configurator**, and paste your Railway URL into the block settings.

An extension-only app doesn't need OAuth or hosting. The Railway app is still where models are stored and served.

### Connecting the store (Shopify sync)
`/admin` → **⇅ Shopify sync** creates a 3D product for every matching Shopify product, copied from a fully set-up template, and refreshes the variants of ones that already exist. It only reads from Shopify.

Without a token it reads public product pages, so it only sees published products and you list handles yourself. To search the catalogue, see drafts and read every variant, connect the Admin API: in the Shopify Dev Dashboard, create an app for your store with **only the `read_products` scope** and install it. Then set these on Railway and redeploy:
```
SHOPIFY_SHOP=yourstore.myshopify.com
SHOPIFY_CLIENT_ID=...            # client-credentials grant (Dev Dashboard apps)
SHOPIFY_CLIENT_SECRET=...
# or, for an older custom app:  SHOPIFY_ADMIN_TOKEN=shpat_xxx
# optional: SHOPIFY_STORE_DOMAIN=yourstore.com  SHOPIFY_API_VERSION=2026-01  SYNC_INTERVAL_MIN=60
```
Options a Shopify product doesn't have (e.g. one product per fabric and size) are fixed from its tags: a value is chosen when every part of its name is a tag value, so `96" - Natural` matches `size:96"` + `construction:Natural`.
