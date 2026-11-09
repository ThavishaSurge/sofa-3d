// Runs inside the iframe. Talks to the parent page (Shopify) via postMessage.
//
// Parent -> iframe:
//   { type: 'sofa3d:setVariant', variantId: '123', extraOptions?: {Construction:'Chaise Left'} }
//   { type: 'sofa3d:setOptions', options: { Fabric: 'Linen', Colour: 'Grey' } }
//   { type: 'sofa3d:resetCamera' }
// Iframe -> parent:
//   { type: 'sofa3d:ready', productId }
//   { type: 'sofa3d:state', state }          after every change
//   { type: 'sofa3d:meta', meta }            mesh/material names (used by the admin)
//   { type: 'sofa3d:unmatched', variantId|options }
import { SofaViewer } from './viewer.js';

const config = window.__SOFA3D_CONFIG__;
const qs = new URLSearchParams(location.search);
const showUi = qs.get('ui') === '1';
const parentWin = window.parent !== window ? window.parent : null;
const post = (msg) => parentWin && parentWin.postMessage({ ...msg, productId: config.id }, '*');

const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
function onStatus(s, msg) {
  if (s === 'loading') { statusEl.className = ''; statusText.textContent = viewer?.root ? 'Updating…' : 'Loading 3D model…'; }
  else if (s === 'ready') statusEl.className = 'hidden';
  else if (s === 'error') { statusEl.className = 'error'; statusText.textContent = msg || 'Could not load model'; }
}

let viewer;
viewer = new SofaViewer(document.getElementById('stage'), config, {
  background: qs.get('bg') ? '#' + qs.get('bg').replace(/^#/, '') : undefined,
  autoRotate: qs.has('autorotate') ? qs.get('autorotate') === '1' : undefined,
  preserveDrawingBuffer: qs.get('test') === '1',
  onStatus,
  onMeta: (meta) => post({ type: 'sofa3d:meta', meta }),
  onChange: (state) => { renderUi(); post({ type: 'sofa3d:state', state }); },
});
window.__sofa3d = viewer; // handy for debugging / automated tests

const initialVariant = qs.get('variant');
if (!(initialVariant && viewer.setVariant(initialVariant))) viewer.apply();

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('sofa3d:')) return;
  if (d.type === 'sofa3d:setVariant') {
    const ok = viewer.setVariant(d.variantId);
    if (!ok) {
      if (d.fallbackOptions) {
        const miss = viewer.setOptions(d.fallbackOptions);
        if (miss.length) post({ type: 'sofa3d:unmatched', options: miss });
      } else post({ type: 'sofa3d:unmatched', variantId: d.variantId });
    }
    if (d.extraOptions && Object.keys(d.extraOptions).length) viewer.setOptions(d.extraOptions);
  } else if (d.type === 'sofa3d:setOptions') {
    const miss = viewer.setOptions(d.options || {});
    if (miss.length) post({ type: 'sofa3d:unmatched', options: miss });
  } else if (d.type === 'sofa3d:resetCamera') viewer.resetCamera();
  else if (d.type === 'sofa3d:getMeta') post({ type: 'sofa3d:meta', meta: viewer.meta() });
});

document.getElementById('btn-reset').onclick = () => viewer.resetCamera();
document.getElementById('btn-full').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
};
const hint = document.getElementById('hint');
viewer.renderer.domElement.addEventListener('pointerdown', () => (hint.style.opacity = 0), { once: true });
setTimeout(() => (hint.style.opacity = 0), 5000);

// Optional built-in option picker (?ui=1) – used for previews / non-Shopify pages
function swatchFor(value) {
  for (const e of value.effects || []) {
    if (e.type === 'texture' && e.map && config.assets[e.map]) return `background-image:url('${config.assets[e.map].url}')`;
  }
  const c = (value.effects || []).find((e) => e.type === 'color');
  return c ? `background:${c.color}` : null;
}
function renderUi() {
  if (!showUi) return;
  document.body.classList.add('with-ui');
  const ui = document.getElementById('ui');
  ui.innerHTML = '';
  for (const opt of config.options || []) {
    if (!opt.values?.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'opt';
    const name = document.createElement('div');
    name.className = 'opt-name';
    name.textContent = opt.name;
    const vals = document.createElement('div');
    vals.className = 'vals';
    for (const v of opt.values) {
      const b = document.createElement('button');
      const sw = swatchFor(v);
      b.className = 'val' + (viewer.selections[opt.id] === v.id ? ' on' : '') + (sw ? '' : ' no-sw');
      if (sw) { const s = document.createElement('span'); s.className = 'sw'; s.style.cssText = sw; b.append(s); }
      b.append(document.createTextNode(v.name));
      b.onclick = () => viewer.setOptions({ [opt.id]: v.id });
      vals.append(b);
    }
    wrap.append(name, vals);
    ui.append(wrap);
  }
  document.getElementById('stage').style.bottom = ui.offsetHeight + 'px';
}

post({ type: 'sofa3d:ready' });
