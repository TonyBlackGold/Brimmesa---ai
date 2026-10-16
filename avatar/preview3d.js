// Preview-only head reconstructed from assets/amara.webp.
// The homepage does not import this. Open ?preview3d=1.
// Morph names are Oculus visemes plus a few ARKit shapes. There is no
// Mixamo body, so this does not go through TalkingHead.showAvatar.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { wordPlan, fillVisemes } from './lipsync.js';

const MODEL = new URL('./models/amara-portrait.glb', import.meta.url);

export async function mount(node, options) {
  const face = new PreviewHead(node, options || {});
  await face.load();
  if (node) node.__character = face;
  return face;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function lerp(a, b, t) { return a + (b - a) * t; }

export class PreviewHead {
  constructor(node, options) {
    this.node = node;
    this.options = options || {};
    this.visible = true;
    this.running = false;
    this.ready = false;
    this.lastError = '';
    this.state = 'idle';
    this.session = 0;
    this.expr = { smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 };
    this.exprTarget = { smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 };
    this.blink = 0;
    this.nextBlink = 0;
    this.blinkPhase = 'wait';
    this.yaw = 0;
    this.yawTarget = 0;
    this.forced = '';
    this.visemeName = 'rest';
    this.plan = null;
    this.sync = () => 0;
    this.source = null;
    this.ctx = null;
    this.raf = 0;
  }

  async load() {
    const parent = this.node;
    if (!parent) throw new Error('Preview head needs a mount');
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', 'Preview of a 3D head built from Amara’s portrait');
    parent.replaceChildren(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x07080c, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.02, 10);
    this.scene.add(new THREE.HemisphereLight(0xfff4e5, 0x1a120c, 0.85));
    const key = new THREE.DirectionalLight(0xfff8ee, 1.25);
    key.position.set(0.35, 0.7, 1.4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc9d7ef, 0.4);
    fill.position.set(-0.9, 0.2, 0.5);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xe7c27a, 0.45);
    rim.position.set(-0.2, 0.6, -1.2);
    this.scene.add(rim);

    const gltf = await new GLTFLoader().loadAsync(MODEL.href);
    this.model = gltf.scene;
    this.faceMesh = null;
    this.model.traverse(obj => {
      if (obj.isMesh && obj.morphTargetDictionary && obj.morphTargetDictionary.viseme_aa != null) this.faceMesh = obj;
    });
    if (!this.faceMesh) throw new Error('Preview head has no viseme blendshapes');
    const box = new THREE.Box3().setFromObject(this.faceMesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.model.position.sub(center);
    this.pivot = new THREE.Group();
    this.pivot.add(this.model);
    this.scene.add(this.pivot);
    this.fit = Math.max(0.22, size.y * 0.62) / Math.tan(THREE.MathUtils.degToRad(14)) * 0.92;
    this.camera.position.set(0, size.y * 0.06, this.fit);
    this.camera.lookAt(0, 0, 0);
    this.buildBar(parent.parentElement || parent);
    this.scheduleBlink(performance.now() + 700);
    this.ready = true;
    this.kick();
  }

  buildBar(host) {
    const bar = document.createElement('div');
    bar.className = 'preview-bar';
    const note = document.createElement('span');
    note.textContent = 'Preview only';
    bar.append(note);
    const add = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);
      bar.append(b);
    };
    add('Front', () => this.setView('front'));
    add('Three-quarter', () => this.setView('three-quarter'));
    add('Speak', () => this.demoSpeak());
    host.append(bar);
    this.bar = bar;
  }

  setView(name) {
    this.yawTarget = name === 'three-quarter' || name === 'three' ? 0.72 : 0;
  }

  holdViseme(name) {
    this.session++;
    this.plan = null;
    this.forced = name ? String(name).replace(/^viseme_/i, '') : '';
    this.visemeName = this.forced || 'rest';
  }

  demoSpeak() {
    const names = ['aa', 'E', 'O', 'U', 'PP', 'aa', 'I', 'O', 'aa'];
    const visemes = [];
    const vtimes = [];
    const vdurations = [];
    names.forEach((n, i) => {
      visemes.push(n);
      vtimes.push(i * 260);
      vdurations.push(210);
    });
    this.forced = '';
    this.startPlan({ visemes, vtimes, vdurations }, null);
  }

  resize() {
    const parent = this.node;
    if (!parent || !this.renderer) return;
    const w = parent.clientWidth || 1;
    const h = parent.clientHeight || 1;
    const ratio = window.matchMedia && matchMedia('(pointer: coarse)').matches ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  kick() {
    if (this.running) { this.resize(); return; }
    this.running = true;
    const loop = now => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now || performance.now());
    };
    this.raf = requestAnimationFrame(loop);
  }

  frame(now) {
    if (!this.visible) return;
    this.resize();
    this.stepExpr(now);
    this.stepBlink(now);
    this.yaw = lerp(this.yaw, this.yawTarget, 0.12);
    const sway = Math.sin(now * 0.0011) * 0.025;
    this.pivot.rotation.y = this.yaw + sway;
    this.pivot.rotation.x = Math.sin(now * 0.0007) * 0.015;
    this.pivot.position.y = Math.sin(now * 0.00115) * 0.002;
    this.applyMorphs(now);
    this.renderer.render(this.scene, this.camera);
  }

  applyMorphs(now) {
    const mesh = this.faceMesh;
    const dict = mesh.morphTargetDictionary;
    const inf = mesh.morphTargetInfluences;
    const shape = this.currentViseme(this.sync());
    this.visemeName = shape.name;
    const k = 1 - Math.exp(-16 / 55);
    Object.keys(dict).forEach(name => {
      if (name.indexOf('viseme_') !== 0) return;
      const want = name === 'viseme_' + shape.name ? 1 : 0;
      const i = dict[name];
      inf[i] = lerp(inf[i], want, k);
    });
    const smile = clamp(this.expr.smile + this.expr.laugh * 0.4, 0, 1);
    this.setWeight(dict, inf, 'mouthSmileLeft', smile * 0.35);
    this.setWeight(dict, inf, 'mouthSmileRight', smile * 0.35);
    this.setWeight(dict, inf, 'browInnerUp', clamp(this.expr.brow, 0, 1) * 0.55);
    this.setWeight(dict, inf, 'eyeBlinkLeft', this.blink);
    this.setWeight(dict, inf, 'eyeBlinkRight', this.blink);
    if (this.expr.laugh > 0.2 && dict.viseme_aa != null && shape.name === 'rest') {
      inf[dict.viseme_aa] = Math.max(inf[dict.viseme_aa], this.expr.laugh * 0.25);
    }
    if (this.expr.concern > 0.2 && dict.browInnerUp != null) {
      inf[dict.browInnerUp] = Math.max(inf[dict.browInnerUp], this.expr.concern * 0.2);
    }
  }

  setWeight(dict, inf, name, value) {
    if (dict[name] == null) return;
    const i = dict[name];
    inf[i] = lerp(inf[i], value, 0.25);
  }

  currentViseme(t) {
    if (this.forced) return { name: this.forced };
    const plan = this.plan;
    if (!plan || !plan.visemes) return { name: 'sil' };
    let name = 'sil';
    for (let i = 0; i < plan.visemes.length; i++) {
      const a = plan.vtimes[i] || 0;
      const b = a + (plan.vdurations[i] || 70);
      if (t >= a && t < b) name = String(plan.visemes[i]).replace(/^viseme_/i, '');
    }
    return { name: name || 'sil' };
  }

  scheduleBlink(at) { this.nextBlink = at; this.blinkPhase = 'wait'; }
  stepBlink(now) {
    if (this.blinkPhase === 'wait' && now >= this.nextBlink) this.blinkPhase = 'closing';
    if (this.blinkPhase === 'closing') {
      this.blink = Math.min(1, this.blink + 0.28);
      if (this.blink >= 1) this.blinkPhase = 'opening';
    } else if (this.blinkPhase === 'opening') {
      this.blink = Math.max(0, this.blink - 0.18);
      if (this.blink <= 0) this.scheduleBlink(now + 2200 + Math.random() * 2600);
    }
  }

  stepExpr(now) {
    const k = 0.08;
    Object.keys(this.expr).forEach(key => { this.expr[key] = lerp(this.expr[key], this.exprTarget[key] || 0, k); });
    if (this.exprHold && now > this.exprHold) this.setState(this.state);
  }

  audioContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    return this.ctx;
  }
  resume() {
    const ctx = this.audioContext();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  setState(state) {
    const next = state === 'listening' || state === 'speaking' || state === 'thinking' ? state : 'idle';
    this.state = next;
    if (this.exprHold && performance.now() < this.exprHold) return;
    if (next === 'listening') this.setExpr({ smile: 0.15, brow: 0.45, gazeY: -0.2 }, 0);
    else if (next === 'thinking') this.setExpr({ concern: 0.25, brow: 0.35, gazeX: 0.62 }, 0);
    else if (next === 'speaking') this.setExpr({ smile: 0.08, brow: 0.12 }, 0);
    else this.setExpr({ smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 }, 0);
  }
  react(emotion) {
    if (emotion === 'laugh') this.setExpr({ smile: 0.55, laugh: 0.45, brow: 0.2 }, 1100);
    else if (emotion === 'smile') this.setExpr({ smile: 0.5, brow: 0.1 }, 1400);
    else if (emotion === 'concern') this.setExpr({ concern: 0.7, brow: 0.35 }, 1600);
    else if (emotion === 'surprise') this.setExpr({ brow: 0.65 }, 900);
  }
  setExpr(partial, hold) {
    this.exprHold = performance.now() + (hold || 0);
    this.exprTarget = Object.assign({ smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 }, partial);
  }
  lookAt() {}
  setTilt() {}

  viseme(name) {
    this.holdViseme(name);
    const token = this.session;
    setTimeout(() => { if (token === this.session) this.forced = ''; }, 140);
  }

  speak(input, opt) {
    opt = opt || {};
    this.session++;
    this.forced = '';
    if (opt.emotion) this.react(opt.emotion);
    if (input && typeof input === 'object' && (input.visemes || input.words || input.audio)) {
      const plan = input.visemes && input.visemes.length ? input : fillVisemes(wordPlan('', 1), null);
      this.startPlan(plan, input.audio && input.audible !== false ? input.audio : null);
      return;
    }
    const text = String(input || '').trim();
    if (!text) return;
    this.startPlan(fillVisemes(wordPlan(text, opt.rate || 1), null), null);
  }

  bindUtterance(utterance) {
    if (!utterance) return;
    const session = this.session;
    utterance.onboundary = ev => {
      if (session !== this.session || !ev || (ev.name && ev.name !== 'word')) return;
      if (typeof ev.elapsedTime !== 'number') return;
      const at = performance.now();
      this.sync = () => ev.elapsedTime + (performance.now() - at);
    };
  }

  interrupt() {
    this.session++;
    this.plan = null;
    this.forced = '';
    this.visemeName = 'rest';
    if (this.source) {
      try { this.source.stop(); } catch (e) {}
      this.source = null;
    }
  }

  startPlan(plan, buffer) {
    this.plan = plan && plan.visemes && plan.visemes.length ? plan : null;
    const started = performance.now();
    this.sync = () => performance.now() - started;
    if (!buffer) return;
    const ctx = this.audioContext();
    if (!ctx) return;
    if (this.source) { try { this.source.stop(); } catch (e) {} }
    const src = ctx.createBufferSource();
    this.source = src;
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => { if (this.source === src) this.source = null; };
    const go = () => {
      if (this.source !== src) return;
      const at = ctx.currentTime + 0.012;
      try { src.start(at); } catch (e) { return; }
      this.sync = () => (ctx.currentTime - at) * 1000;
    };
    if (ctx.state === 'running') go();
    else ctx.resume().then(go).catch(() => {});
  }

  diagnostics() {
    const c = this.canvas;
    return {
      running: this.running,
      css: c ? c.clientWidth + 'x' + c.clientHeight : '0x0',
      buffer: c ? c.width + 'x' + c.height : '0x0',
      webgl: 'webgl2',
      audio: this.ctx ? this.ctx.state : 'none',
      lost: false,
      error: this.lastError,
      mouth: this.visemeName
    };
  }

  setVisible(on) {
    this.visible = !!on;
    if (this.canvas) this.canvas.style.visibility = on ? 'visible' : 'hidden';
    if (this.bar) this.bar.hidden = !on;
    if (on) this.kick();
  }

  dispose() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.interrupt();
    if (this.bar && this.bar.remove) this.bar.remove();
    if (this.renderer) this.renderer.dispose();
    this.ready = false;
  }
}
