"""E2E: build options by hand, generate all combinations, paste Shopify variant IDs, then drive the
viewer from a mock Shopify page on another origin.
usage: python3 test/e2e/manual_mapping.py [app_url] [password] [shop_url]
(needs: pip install playwright; the server running; `python3 -m http.server 4001` in public/demo)"""
import asyncio, sys, os, time
from playwright.async_api import async_playwright
APP = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
PW = sys.argv[2] if len(sys.argv) > 2 else 'admin'
SHOP = sys.argv[3] if len(sys.argv) > 3 else 'http://localhost:4001'
SAMPLE = os.path.join(os.path.dirname(__file__), '..', '..', 'sample')
CHROME = dict(executable_path=os.environ.get('CHROME')) if os.environ.get('CHROME') else {}
res = []
def check(n, c, x=''): res.append(c); print(('PASS ' if c else 'FAIL ') + n, x)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1440, 'height': 950})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept('Manual mapping sofa')))
        await pg.goto(APP + '/admin/')
        await pg.fill('input[type=password]', PW); await pg.click('button[type=submit]')
        await pg.click('text=+ New product'); await pg.wait_for_selector('.editor')
        await (await pg.query_selector_all('input[type=file]'))[0].set_input_files(f'{SAMPLE}/sofa.glb')
        await pg.wait_for_selector('.file.main', timeout=15000)
        await (await pg.query_selector_all('input[type=file]'))[1].set_input_files([f'{SAMPLE}/linen.png', f'{SAMPLE}/velvet.png'])
        await pg.wait_for_function('document.querySelectorAll(".files:not(.models) .file").length===2', timeout=15000)
        await pg.wait_for_selector('text=Detected in main model', timeout=60000)
        # Options built by hand
        await pg.click('.tabs button:has-text("Options")')
        await pg.click('button:text-is("+ Custom option")')
        opt = pg.locator('.opt').nth(0)
        await opt.locator('.opt-head input').fill('Fabric')
        for name, tex in [('Linen', 'linen.png'), ('Velvet', 'velvet.png')]:
            await opt.locator('button:text-is("+ Add value")').click()
            opt = pg.locator('.opt').nth(0)
            val = opt.locator('.val').nth(-2)
            await val.locator('.val-head input').first.fill(name)
            await val.locator('.val-head select').select_option('texture')
            val = pg.locator('.opt').nth(0).locator('.val').nth(-2)
            await val.locator('.effect .chip:text-is("Fabric")').click()
            await val.locator('.effect select').first.select_option(label=tex)
        await pg.click('button:text-is("+ Custom option")')
        opt = pg.locator('.opt').nth(1)
        await opt.locator('.opt-head input').fill('Colour')
        for name, hexv in [('Oat', '#e3d6bf'), ('Navy', '#1f2a44')]:
            await opt.locator('button:text-is("+ Add value")').click()
            opt = pg.locator('.opt').nth(1)
            val = opt.locator('.val').nth(-2)
            await val.locator('.val-head input').first.fill(name)
            await val.locator('.val-head select').select_option('color')
            val = pg.locator('.opt').nth(1).locator('.val').nth(-2)
            await val.locator('.effect .chip:text-is("Fabric")').click()
            await val.locator('.effect input:not([type=color])').last.fill(hexv)
        # Generate combinations + paste IDs
        await pg.click('.tabs button:has-text("Shopify variants")')
        await pg.fill('input[placeholder="product-handle"]', f'manual-{time.time_ns()}')
        await pg.click('text=Generate all combinations')
        rows = pg.locator('.vt tbody tr')
        check('4 combinations generated', await rows.count() == 4)
        check('missing-ID warning shown', await pg.is_visible('text=4 row(s) missing a variant ID'))
        ids = {}
        for i in range(4):
            title = await rows.nth(i).locator('td').nth(1).inner_text()
            vid = str(7000 + i); ids[title] = vid
            inp = rows.nth(i).locator('td input')
            await inp.fill(vid); await inp.press('Tab')
        # duplicate-ID guard in the UI
        inp = rows.nth(3).locator('td input')
        await inp.fill('7000'); await inp.press('Tab')
        check('duplicate ID rejected in UI', await inp.input_value() == '7003')
        await pg.screenshot(path='/tmp/sofa3d-m1-combos.png')
        await pg.keyboard.press('Control+s')
        await pg.wait_for_selector('#toast.show:has-text("Saved")')
        pid = pg.url.split('/p/')[1]
        # Shopper on the store
        await pg.goto(f'{SHOP}/index.html?app={APP}&product={pid}')
        await pg.wait_for_selector('iframe')
        for _ in range(50):
            fr = [x for x in pg.frames if '/embed/' in x.url]
            if fr: break
            await pg.wait_for_timeout(200)
        f = fr[0]
        await f.wait_for_function('window.__sofa3d && window.__sofa3d.root', timeout=60000)
        for fab, col in [('Velvet', 'Navy'), ('Linen', 'Navy'), ('Linen', 'Oat')]:
            await pg.click(f'fieldset span:text-is("{fab}")'); await pg.click(f'fieldset span:text-is("{col}")')
            want = ids[f'{fab} / {col}']
            check(f'store variant id for {fab}/{col} is {want}', await pg.eval_on_selector('#variant-id', 'e=>e.value') == want)
            await f.wait_for_function(f'window.__sofa3d.state().variantId === "{want}" && document.getElementById("status").className==="hidden"', timeout=20000)
            st = await f.evaluate('window.__sofa3d.state()')
            exp_hex = '#1f2a44' if col == 'Navy' else '#e3d6bf'
            check(f'3D shows {fab}/{col}', st['meshes']['Base']['map'] == f'{fab.lower()}.png' and st['meshes']['Base']['color'] == exp_hex, str(st['meshes']['Base']))
        await pg.screenshot(path='/tmp/sofa3d-m2-store.png')
        check('no page errors', not errs, str(errs))
        print(f'{sum(res)} passed, {len(res) - sum(res)} failed')
        await b.close()
        sys.exit(0 if all(res) else 1)
asyncio.run(main())
