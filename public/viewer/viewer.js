// Sofa 3D viewer core – three.js scene that swaps fabrics / colours / sizes / constructions.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

let gltfLoader;
function getLoader() {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
  gltfLoader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  return gltfLoader;
}

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const EFFECT_ORDER = ['model', 'visibility', 'scale', 'texture', 'color'];

export class SofaViewer {
  constructor(container, config, opts = {}) {
    this.container = container;
    this.config = config;
    this.opts = opts;
    this.onChange = opts.onChange || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.models = new Map();   // assetId -> Promise<root>
    this.textures = new Map(); // key -> Promise<Texture>
    this.root = null;
    this.currentModelId = null;
    this.applySeq = 0;
    this.dirty = true;
    this.selections = {};
    this.#initSelections();
    this.#initScene();
  }

  // ---------------- selections ----------------
  #initSelections() {
    const sel = { ...(this.config.defaults || {}) };
    for (const opt of this.config.options || []) {
      if (!opt.values?.length) continue;
      if (!opt.values.some((v) => v.id === sel[opt.id])) sel[opt.id] = opt.values[0].id;
    }
    this.selections = sel;
  }

  findOption(key) {
    const n = norm(key);
    return (this.config.options || []).find((o) => o.id === key || norm(o.name) === n);
  }

  findValue(opt, key) {
    const n = norm(key);
    return opt.values.find((v) => v.id === key || norm(v.name) === n || (v.aliases || []).some((a) => norm(a) === n));
  }

  /** Select a Shopify variant by id. Returns false if the id is not mapped. */
  setVariant(variantId) {
    if (variantId == null || variantId === '') return false;
    const v = (this.config.variants || []).find((x) => x.id && String(x.id) === String(variantId));
    if (!v) return false;
    this.selections = { ...this.selections, ...v.selections };
    this.apply();
    return true;
  }

  /** Select by option name/value name, e.g. {Fabric:'Linen', Colour:'Grey'}. Returns list of unmatched keys. */
  setOptions(map = {}) {
    const unmatched = [];
    const next = { ...this.selections };
    for (const [k, val] of Object.entries(map)) {
      const opt = this.findOption(k);
      const v = opt && this.findValue(opt, val);
      if (v) next[opt.id] = v.id; else unmatched.push(`${k}=${val}`);
    }
    this.selections = next;
    this.apply();
    return unmatched;
  }

  matchingVariantId() {
    const v = (this.config.variants || []).find((x) => x.id &&
      Object.entries(x.selections || {}).every(([o, val]) => this.selections[o] === val) && Object.keys(x.selections || {}).length);
    return v ? v.id : null;
  }

  selectedValues() {
    const out = [];
    for (const opt of this.config.options || []) {
      const v = opt.values.find((x) => x.id === this.selections[opt.id]);
      if (v) out.push({ option: opt, value: v });
    }
    return out;
  }

  // ---------------- scene ----------------
  #initScene() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: !!this.opts.preserveDrawingBuffer }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = this.config.viewer?.exposure ?? 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    const bg = this.opts.background ?? this.config.viewer?.background;
    if (bg && bg !== 'transparent') this.scene.background = new THREE.Color(bg);
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.autoRotate = !!(this.opts.autoRotate ?? this.config.viewer?.autoRotate);
    this.controls.autoRotateSpeed = 0.8;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.userMoved = true; });

    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 6;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 0.4));

    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.visible = this.config.viewer?.showFloorShadow !== false;
    this.scene.add(this.floor);

    const resize = () => {
      const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
      r.setSize(w, h, false);
      r.domElement.style.width = '100%';
      r.domElement.style.height = '100%';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.root && !this.userMoved) this.#frame(this.root);
      this.dirty = true;
    };
    new ResizeObserver(resize).observe(this.container);
    resize();

    r.setAnimationLoop(() => {
      const moved = this.controls.update();
      if (moved || this.dirty) {
        r.render(this.scene, this.camera);
        this.dirty = false;
        this.frames = (this.frames || 0) + 1;
      }
    });
  }

  #loadModel(assetId) {
    if (this.models.has(assetId)) return this.models.get(assetId);
    const asset = this.config.assets?.[assetId];
    if (!asset) return Promise.reject(new Error('Model file missing'));
    const p = getLoader().loadAsync(asset.url).then((gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        o.userData.baseVisible = o.visible;
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        // clone so per-mesh targeting never leaks into meshes that share a material
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const cloned = mats.map((m) => {
          const c = m.clone();
          c.userData.base = {
            color: c.color ? c.color.clone() : null, map: c.map || null, normalMap: c.normalMap || null,
            roughnessMap: c.roughnessMap || null, roughness: c.roughness, metalness: c.metalness,
          };
          return c;
        });
        o.material = Array.isArray(o.material) ? cloned : cloned[0];
      });
      return root;
    });
    this.models.set(assetId, p);
    p.catch(() => this.models.delete(assetId));
    return p;
  }

  #loadTexture(assetId, { srgb, repeat }) {
    const asset = this.config.assets?.[assetId];
    if (!asset) return Promise.resolve(null);
    const key = `${assetId}|${srgb}|${repeat}`;
    if (!this.textures.has(key)) {
      this.textures.set(key, new THREE.TextureLoader().loadAsync(asset.url).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        const rp = Number(repeat) || 1;
        t.repeat.set(rp, rp);
        t.flipY = false; // glTF UV convention
        t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        return t;
      }));
    }
    return this.textures.get(key);
  }

  #frame(root) {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    // fit the bounding sphere into whichever FOV (vertical/horizontal) is narrower
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || maxDim / 2;
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.92;
    const dir = new THREE.Vector3(0.75, 0.45, 1.25).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.minDistance = dist * 0.35;
    this.controls.maxDistance = dist * 3;
    this.controls.update();
    this.homeView = { pos: this.camera.position.clone(), target: center.clone() };
    // floor + light sized to the model
    this.floor.position.set(center.x, box.min.y, center.z);
    this.floor.scale.setScalar(maxDim * 6);
    this.sun.position.set(center.x + maxDim * 1.2, box.min.y + maxDim * 2.5, center.z + maxDim * 1.5);
    this.sun.target.position.copy(center);
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -maxDim * 1.5;
    s.right = s.top = maxDim * 1.5;
    s.near = 0.01;
    s.far = maxDim * 8;
    s.updateProjectionMatrix();
  }

  resetCamera() {
    if (this.root) { this.userMoved = false; this.#frame(this.root); this.dirty = true; return; }
    if (!this.homeView) return;
    this.camera.position.copy(this.homeView.pos);
    this.controls.target.copy(this.homeView.target);
    this.dirty = true;
  }

  /** Names a merchant can target: mesh/node names and material names. */
  meta() {
    const meshes = new Set(), materials = new Set(), nodes = new Set();
    this.root?.traverse((o) => {
      if (o.name) nodes.add(o.name);
      if (o.isMesh) {
        if (o.name) meshes.add(o.name);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.name && materials.add(m.name));
      }
    });
    return { meshes: [...meshes], materials: [...materials], nodes: [...nodes] };
  }

  // ---------------- apply ----------------
  async apply() {
    const seq = ++this.applySeq;
    this.onStatus('loading');
    try {
      const chosen = this.selectedValues();
      const effects = {};
      EFFECT_ORDER.forEach((t) => (effects[t] = []));
      for (const { value } of chosen) for (const e of value.effects || []) effects[e.type]?.push(e);

      const modelId = effects.model.filter((e) => e.model).at(-1)?.model || this.config.modelAssetId;
      if (!modelId) { this.onStatus('error', 'No 3D model uploaded yet'); return; }

      // Load everything first, then swap in one go (no flicker).
      const texJobs = effects.texture.map((e) => Promise.all([
        e.map ? this.#loadTexture(e.map, { srgb: true, repeat: e.repeat }) : null,
        e.normalMap ? this.#loadTexture(e.normalMap, { srgb: false, repeat: e.repeat }) : null,
        e.roughnessMap ? this.#loadTexture(e.roughnessMap, { srgb: false, repeat: e.repeat }) : null,
      ]));
      const [root, texResults] = await Promise.all([this.#loadModel(modelId), Promise.all(texJobs)]);
      if (seq !== this.applySeq) return; // a newer selection superseded this one

      if (this.currentModelId !== modelId) {
        if (this.root) this.scene.remove(this.root);
        this.scene.add(root);
        const first = !this.root;
        this.root = root;
        this.currentModelId = modelId;
        if (first || !this.opts.keepCameraOnModelSwap) this.#frame(root);
        this.opts.onMeta?.(this.meta());
      }

      // reset to base
      root.scale.set(1, 1, 1);
      root.traverse((o) => {
        o.visible = o.userData.baseVisible !== false;
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          const b = m.userData.base;
          if (!b) continue;
          if (b.color && m.color) m.color.copy(b.color);
          m.map = b.map; m.normalMap = b.normalMap; m.roughnessMap = b.roughnessMap;
          m.roughness = b.roughness; m.metalness = b.metalness;
          m.userData.mapAsset = null;
          m.needsUpdate = true;
        }
      });

      const nameSet = (list) => new Set((list || []).map(norm).filter(Boolean));
      const matches = (o, m, set) => {
        if (set.has(norm(m?.name))) return true;
        for (let p = o; p; p = p.parent) if (p.name && set.has(norm(p.name))) return true;
        return false;
      };
      const eachMaterial = (targets, fn) => {
        const set = nameSet(targets);
        const all = set.size === 0; // no targets = whole model
        root.traverse((o) => {
          if (!o.isMesh) return;
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (all || matches(o, m, set)) fn(m);
        });
      };

      for (const e of effects.visibility) {
        const show = nameSet(e.show), hide = nameSet(e.hide);
        root.traverse((o) => {
          const n = norm(o.name);
          if (!n) return;
          if (show.has(n)) o.visible = true;
          if (hide.has(n)) o.visible = false;
        });
      }
      for (const e of effects.scale) {
        const s = e.scale || [1, 1, 1];
        root.scale.multiply(new THREE.Vector3(+s[0] || 1, +s[1] || 1, +s[2] || 1));
      }
      effects.texture.forEach((e, i) => {
        const [map, normalMap, roughnessMap] = texResults[i];
        eachMaterial(e.targets, (m) => {
          if (map) { m.map = map; m.userData.mapAsset = e.map; if (m.color && !e.keepColor) m.color.set('#ffffff'); }
          if (normalMap) m.normalMap = normalMap;
          if (roughnessMap) m.roughnessMap = roughnessMap;
          if (e.roughness != null && e.roughness !== '') m.roughness = +e.roughness;
          if (e.metalness != null && e.metalness !== '') m.metalness = +e.metalness;
          m.needsUpdate = true;
        });
      });
      for (const e of effects.color) {
        eachMaterial(e.targets, (m) => m.color && m.color.set(e.color || '#ffffff'));
      }

      this.dirty = true;
      this.onStatus('ready');
      this.onChange(this.state());
    } catch (err) {
      if (seq === this.applySeq) this.onStatus('error', err.message || String(err));
      console.error(err);
    }
  }

  /** Snapshot used by the parent page and by tests. */
  state() {
    const meshes = {};
    this.root?.traverse((o) => {
      if (!o.isMesh) return;
      let visible = true;
      for (let p = o; p; p = p.parent) if (!p.visible) visible = false;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const mapName = this.config.assets?.[m.userData.mapAsset]?.name || null;
      meshes[o.name || o.uuid] = { visible, color: m.color ? '#' + m.color.getHexString() : null, map: mapName };
    });
    return {
      selections: Object.fromEntries(this.selectedValues().map(({ option, value }) => [option.name, value.name])),
      variantId: this.matchingVariantId(),
      modelAssetId: this.currentModelId,
      scale: this.root ? this.root.scale.toArray() : null,
      meshes,
    };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }
}
