"""E2E: mock Shopify page (other origin) drives the 3D iframe. Run `npm run seed` first.
usage: python3 test/e2e/shopify_bridge.py PRODUCT_ID [app_url] [shop_url]"""
import asyncio, json, sys
from playwright.async_api import async_playwright
PID=sys.argv[1]; APP=sys.argv[2] if len(sys.argv)>2 else 'http://localhost:3000'; SHOP=sys.argv[3] if len(sys.argv)>3 else 'http://localhost:4001'
import os
CHROME=dict(executable_path=os.environ['CHROME']) if os.environ.get('CHROME') else {}
ok=[]; fail=[]
def check(name, cond, extra=''):
    (ok if cond else fail).append(name); print(('PASS ' if cond else 'FAIL ')+name, extra)
async def frame_state(pg):
    await pg.wait_for_selector('iframe', timeout=20000)
    await pg.wait_for_function('true')
    for _ in range(50):
        fs=[fr for fr in pg.frames if '/embed/' in fr.url]
        if fs: break
        await pg.wait_for_timeout(200)
    f = fs[0]
    await f.wait_for_function('window.__sofa3d && window.__sofa3d.root && document.getElementById("status").className==="hidden"', timeout=60000)
    return f, await f.evaluate('window.__sofa3d.state()')
async def settle(pg, f, expect_variant):
    await f.wait_for_function(f'window.__sofa3d.state().variantId === "{expect_variant}" && document.getElementById("status").className==="hidden"', timeout=20000)
    return await f.evaluate('window.__sofa3d.state()')
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(**CHROME, args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width':1300,'height':850})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        # 1. product-id mode, default variant
        await pg.goto(f'{SHOP}/index.html?app={APP}&product={PID}')
        f, st = await frame_state(pg)
        vid = await pg.eval_on_selector('#variant-id','e=>e.value')
        check('initial variant synced', st['variantId']==vid, f"{vid} {st['selections']}")
        # 2. click variant buttons like a shopper
        for label in ['Velvet','Charcoal','Chaise Right','2 Seater']:
            await pg.click(f'fieldset span:text-is("{label}")')
            vid = await pg.eval_on_selector('#variant-id','e=>e.value')
            st = await settle(pg, f, vid)
            check(f'click {label} -> iframe variant {vid}', st['variantId']==vid, str(st['selections']))
        check('chaise right visible', st['meshes']['Chaise_R_Base']['visible'] and not st['meshes']['Chaise_L_Base']['visible'])
        check('2 seater scale', st['scale'][0]==0.8, str(st['scale']))
        check('velvet + charcoal applied', st['meshes']['Base']['map']=='velvet.png' and st['meshes']['Base']['color']=='4a4a4c'.join(['#','']), str(st['meshes']['Base']))
        legs=[v for k,v in st['meshes'].items() if k.startswith('Leg_')]
        check('legs untouched by fabric/colour', len(legs)==4 and all(l['map'] is None and l['color']!='#4a4a4c' for l in legs), str(legs[:1]))
        await pg.wait_for_timeout(600)
        await pg.screenshot(path='/tmp/shop1.png')
        # 3. JS API
        await pg.evaluate("Sofa3D.setOptions({Fabric:'Linen', Colour:'Terracotta'})")
        await f.wait_for_function("window.__sofa3d.state().selections.Colour==='Terracotta'", timeout=10000)
        check('JS API setOptions', True)
        # 4. deep link ?variant=
        target='46000000000050'
        await pg.goto(f'{SHOP}/index.html?app={APP}&product={PID}&variant={target}')
        f, st = await frame_state(pg)
        st = await settle(pg, f, target)
        check('deep-linked ?variant= preselected', st['variantId']==target, str(st['selections']))
        # 5. handle mode (universal snippet)
        await pg.goto(f'{SHOP}/index.html?app={APP}&product={PID}&mode=handle&handle=oslo-sofa')
        f, st = await frame_state(pg)
        check('handle lookup mounts iframe', bool(st['variantId']))
        await pg.click('fieldset span:text-is("Boucle")')
        vid = await pg.eval_on_selector('#variant-id','e=>e.value')
        st = await settle(pg, f, vid)
        check('handle mode syncs clicks', st['selections']['Fabric']=='Boucle')
        await pg.goto(f'{SHOP}/index.html?app={APP}&product={PID}&mode=handle&handle=no-such-sofa')
        await pg.wait_for_timeout(2500)
        hidden = await pg.eval_on_selector('[data-sofa3d-handle]','e=>e.style.display==="none" && !e.querySelector("iframe")')
        check('unknown handle renders nothing', hidden)
        # 6. options-app style line item property overrides construction
        await pg.goto(f'{SHOP}/index.html?app={APP}&product={PID}')
        f, st = await frame_state(pg)
        await pg.evaluate('''() => { const s=document.createElement('select'); s.name='properties[Construction]';
          s.innerHTML='<option value="">Choose</option><option>Chaise Left</option><option>Chaise Right</option>';
          document.getElementById('product-form').appendChild(s); }''')
        await pg.select_option('select[name="properties[Construction]"]', 'Chaise Left')
        await f.wait_for_function("window.__sofa3d.state().selections.Construction==='Chaise Left'", timeout=10000)
        await pg.click('fieldset span:text-is("Terracotta")')
        await f.wait_for_function("window.__sofa3d.state().selections.Colour==='Terracotta'", timeout=10000)
        st = await f.evaluate('window.__sofa3d.state()')
        check('line-item property option survives variant change', st['selections']['Construction']=='Chaise Left' and st['meshes']['Chaise_L_Base']['visible'], str(st['selections']))
        check('no page errors', not errs, str(errs))
        print(f'\n{len(ok)} passed, {len(fail)} failed')
        await b.close()
asyncio.run(main())
