// Photo warp for a still portrait. The pixels stay the coach's photo.
// Mouth shapes are small, eased, and pinned to the jaw. Hair, earrings,
// and the necklace barely move. Another coach can pass her own photo
// and avatar/landmarks/<id>.json later.

import { wordPlan, fillVisemes } from './lipsync.js';

const SHAPE = {
  PP: { open: -0.42, wide: -0.06, round: 0.04 },
  FF: { open: -0.12, wide: 0.08, round: 0.05 },
  aa: { open: 0.48, wide: 0.06, round: 0 },
  E: { open: 0.16, wide: 0.55, round: 0 },
  I: { open: 0.12, wide: 0.42, round: 0 },
  O: { open: 0.22, wide: -0.16, round: 0.72 },
  U: { open: 0.14, wide: -0.22, round: 0.84 },
  DD: { open: 0.16, wide: 0.04, round: 0.04 },
  nn: { open: 0.08, wide: 0.02, round: 0 },
  SS: { open: 0.06, wide: 0.18, round: 0.04 },
  CH: { open: 0.14, wide: 0.06, round: 0.18 },
  kk: { open: 0.18, wide: 0.02, round: 0.06 },
  RR: { open: 0.14, wide: 0.02, round: 0.12 },
  TH: { open: 0.12, wide: 0.1, round: 0.04 }
};

const REST = { open: 0, wide: 0, round: 0 };

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function shapeOf(name) {
  if (!name) return REST;
  const key = String(name).replace(/^viseme_/i, '');
  return SHAPE[key] || SHAPE[key.toLowerCase()] || REST;
}

export async function mount(node, options) {
  const face = new PortraitFace(node, options || {});
  await face.load();
  if (node) node.__character = face;
  return face;
}

export class PortraitFace {
  constructor(node, options) {
    this.node = node;
    this.options = options || {};
    this.profile = options.profile || {};
    this.visible = true;
    this.running = false;
    this.lastError = '';
    this.state = 'idle';
    this.session = 0;
    this.pose = { open: 0, wide: 0, round: 0, viseme: 'rest' };
    this.eased = { open: 0, wide: 0, round: 0 };
    this.expr = { smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 };
    this.exprTarget = { smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 };
    this.blink = 0;
    this.nextBlink = 0;
    this.tiltOn = false;
    this.tilt = { x: 0, y: 0 };
    this.tiltTarget = { x: 0, y: 0 };
    this.sync = () => 0;
    this.plan = null;
    this.source = null;
    this.raf = 0;
    this.gl = null;
  }

  async load() {
    const id = this.profile.id || 'amara';
    const imageUrl = this.options.imageUrl || this.profile.portrait;
    if (!imageUrl) throw new Error('Portrait warp needs a photo');
    const landmarksUrl = this.options.landmarksUrl || new URL('./landmarks/' + id + '.json', import.meta.url).href;
    const [mesh, image] = await Promise.all([
      fetch(landmarksUrl).then(r => { if (!r.ok) throw new Error('No face mesh for ' + id); return r.json(); }),
      loadImage(new URL(imageUrl, document.baseURI).href)
    ]);
    this.mesh = mesh;
    this.image = image;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    if (this.node) {
      this.node.replaceChildren();
      this.node.append(this.canvas);
    }
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', ev => {
      if (ev && ev.preventDefault) ev.preventDefault();
      this.lastError = 'WebGL context lost';
      this.running = false;
    });
    this.buildGL();
    this.scheduleBlink(performance.now() + 600);
    if (typeof window !== 'undefined' && window.localStorage && localStorage.getItem('brimmesa.tilt') === 'on') this.setTilt(true);
    this.kick();
  }

  buildGL() {
    const gl = this.gl;
    const vs = compile(gl, gl.VERTEX_SHADER, `
      attribute vec2 aClip;
      attribute vec2 aImg;
      attribute float aShade;
      varying vec2 vImg;
      varying float vShade;
      void main() {
        gl_Position = vec4(aClip, 0.0, 1.0);
        vImg = aImg;
        vShade = aShade;
      }
    `);
    const fs = compile(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D uTex;
      uniform vec2 uFace;
      uniform vec2 uShift;
      uniform float uMask;
      varying vec2 vImg;
      varying float vShade;
      void main() {
        vec2 p = vImg;
        float ax = abs(p.x - uFace.x) / 0.11;
        float ay = abs(p.y - uFace.y) / 0.30;
        float t = min(1.0, sqrt(ax * ax + ay * ay));
        float depth = (1.0 - t) * (1.0 - t);
        vec2 uv = vec2(p.x, 1.0 - p.y) + uShift * depth;
        vec4 color = texture2D(uTex, uv);
        color.rgb *= vShade;
        float alpha = 1.0;
        if (uMask > 0.5) {
          alpha = smoothstep(uFace.y + 0.02, uFace.y + 0.10, p.y);
        }
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color.rgb, alpha);
      }
    `);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('Portrait shader failed');
    gl.useProgram(this.program);
    this.loc = {
      clip: gl.getAttribLocation(this.program, 'aClip'),
      img: gl.getAttribLocation(this.program, 'aImg'),
      shade: gl.getAttribLocation(this.program, 'aShade'),
      face: gl.getUniformLocation(this.program, 'uFace'),
      shift: gl.getUniformLocation(this.program, 'uShift'),
      mask: gl.getUniformLocation(this.program, 'uMask')
    };
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.image);
    this.plateBuf = gl.createBuffer();
    this.faceBuf = gl.createBuffer();
    this.faceCount = (this.mesh.tris || []).length;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  kick() {
    this.resize();
    if (this.visible) this.start();
    this.render();
  }

  resize() {
    const node = this.node;
    const canvas = this.canvas;
    if (!canvas) return;
    const w = Math.max(2, (node && node.clientWidth) || canvas.clientWidth || 2);
    const h = Math.max(2, (node && node.clientHeight) || canvas.clientHeight || 2);
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const dpr = window.devicePixelRatio || 1;
    const ratio = coarse ? 1 : Math.min(1.5, dpr);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    if (this.gl) this.gl.viewport(0, 0, canvas.width, canvas.height);
    this.view = { w, h };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = now => {
      if (!this.running) return;
      this.frame(now || performance.now());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setVisible(on) {
    this.visible = !!on;
    if (this.visible) this.kick();
    else this.stop();
  }

  setTilt(on) {
    this.tiltOn = !!on;
    if (!on) {
      this.tiltTarget = { x: 0, y: 0 };
      return;
    }
    const arm = () => {
      if (this._tiltBound) return;
      this._tiltBound = ev => {
        if (!this.tiltOn) return;
        const x = clamp((Number(ev.gamma) || 0) / 28, -1, 1);
        const y = clamp((Number(ev.beta) || 0) / 40, -1, 1);
        this.tiltTarget = { x, y };
      };
      window.addEventListener('deviceorientation', this._tiltBound);
    };
    const req = window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission;
    if (typeof req === 'function') req.call(DeviceOrientationEvent).then(s => { if (s === 'granted') arm(); }).catch(() => {});
    else arm();
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
    if (next === 'listening') this.setExpr({ smile: 0.15, brow: 0.45, gazeX: 0, gazeY: -0.2 }, 0);
    else if (next === 'thinking') this.setExpr({ concern: 0.25, brow: 0.35, gazeX: 0.62, gazeY: 0.1 }, 0);
    else if (next === 'speaking') this.setExpr({ smile: 0.08, brow: 0.12, gazeX: 0, gazeY: 0 }, 0);
    else this.setExpr({ smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 }, 0);
  }

  react(emotion) {
    if (emotion === 'laugh') this.setExpr({ smile: 0.55, laugh: 0.45, brow: 0.2 }, 1100);
    else if (emotion === 'smile') this.setExpr({ smile: 0.5, brow: 0.1 }, 1400);
    else if (emotion === 'concern') this.setExpr({ concern: 0.7, brow: 0.35, gazeY: 0.15 }, 1600);
    else if (emotion === 'surprise') this.setExpr({ brow: 0.65, gazeY: -0.25 }, 900);
  }

  setExpr(partial, hold) {
    this.exprHold = performance.now() + (hold || 0);
    this.exprTarget = Object.assign({ smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 }, partial);
  }

  lookAt(target) {
    if (target === 'ahead') this.setExpr({ gazeX: 0.4, gazeY: 0 }, 800);
    else this.setExpr({ gazeX: 0, gazeY: 0 }, 600);
  }

  viseme(name) {
    this.pulse = { shape: shapeOf(name), until: performance.now() + 90 };
  }

  speak(input, opt) {
    opt = opt || {};
    this.session++;
    if (opt.emotion) this.react(opt.emotion);
    if (input && typeof input === 'object' && (input.visemes || input.words || input.audio)) {
      const plan = planFrom(input);
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
      if (session !== this.session || !ev || ev.name && ev.name !== 'word') return;
      if (typeof ev.elapsedTime !== 'number') return;
      const at = performance.now();
      this.sync = () => ev.elapsedTime + (performance.now() - at);
    };
  }

  interrupt() {
    this.session++;
    this.plan = null;
    this.pose.viseme = 'rest';
    if (this.source) {
      try { this.source.stop(); } catch (e) {}
      this.source = null;
    }
  }

  startPlan(plan, buffer) {
    this.plan = plan && plan.visemes && plan.visemes.length ? plan : null;
    this.pose.viseme = 'rest';
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
    let armed = false;
    const go = () => {
      if (armed || this.source !== src) return;
      armed = true;
      const at = ctx.currentTime + 0.012;
      try { src.start(at); } catch (e) { return; }
      this.sync = () => (ctx.currentTime - at) * 1000;
    };
    if (ctx.state === 'running') go();
    else ctx.resume().then(go).catch(() => {});
  }

  frame(now) {
    const target = this.targetShape(this.sync());
    const k = 1 - Math.exp(-16 / 55);
    this.eased.open = lerp(this.eased.open, target.open, k);
    this.eased.wide = lerp(this.eased.wide, target.wide, k);
    this.eased.round = lerp(this.eased.round, target.round, k);
    this.pose.open = this.eased.open;
    this.pose.wide = this.eased.wide;
    this.pose.round = this.eased.round;
    this.pose.viseme = target.name;
    this.stepExpr(now);
    this.stepBlink(now);
    this.tilt.x = lerp(this.tilt.x, this.tiltOn ? this.tiltTarget.x : 0, 0.08);
    this.tilt.y = lerp(this.tilt.y, this.tiltOn ? this.tiltTarget.y : 0, 0.08);
    this.render();
  }

  targetShape(t) {
    const plan = this.plan;
    let base = REST;
    let name = 'rest';
    if (plan && plan.visemes) {
      let next = null;
      for (let i = 0; i < plan.visemes.length; i++) {
        const a = plan.vtimes[i] || 0;
        const b = a + (plan.vdurations[i] || 60);
        if (t >= a && t < b) {
          base = shapeOf(plan.visemes[i]);
          name = plan.visemes[i];
        } else if (a > t && (!next || a < next.a)) next = { a, shape: shapeOf(plan.visemes[i]), name: plan.visemes[i] };
      }
      if (name === 'rest' && next && next.a - t < 45) {
        base = next.shape;
        name = next.name;
      } else if (next && next.a - t < 55 && name !== 'rest') {
        const u = (1 - (next.a - t) / 55) * 0.32;
        base = {
          open: lerp(base.open, next.shape.open, u),
          wide: lerp(base.wide, next.shape.wide, u),
          round: lerp(base.round, next.shape.round, u)
        };
      }
    }
    if (this.pulse && performance.now() < this.pulse.until) {
      base = this.pulse.shape;
      name = 'pulse';
    }
    const e = this.expr;
    return {
      name,
      open: clamp(base.open + e.laugh * 0.18, -0.48, 0.55),
      wide: clamp(base.wide + e.smile * 0.22 - e.concern * 0.08, -0.28, 0.62),
      round: clamp(base.round, 0, 0.88)
    };
  }

  stepExpr(now) {
    if (this.exprHold && now > this.exprHold && this.state === 'idle') {
      this.exprTarget = { smile: 0, laugh: 0, concern: 0, brow: 0, gazeX: 0, gazeY: 0 };
      this.exprHold = 0;
    }
    const k = 1 - Math.exp(-16 / 180);
    Object.keys(this.expr).forEach(key => {
      this.expr[key] = lerp(this.expr[key], this.exprTarget[key] || 0, k);
    });
  }

  stepBlink(now) {
    if (!this.nextBlink) this.scheduleBlink(now + 400);
    if (now >= this.nextBlink && this.blink < 0.05) this.blinkStart = now;
    if (this.blinkStart) {
      const u = (now - this.blinkStart) / 150;
      this.blink = u < 0.45 ? u / 0.45 : u < 1 ? 1 - (u - 0.45) / 0.55 : 0;
      if (u >= 1) { this.blink = 0; this.blinkStart = 0; this.scheduleBlink(now); }
    }
  }

  scheduleBlink(now) {
    const rate = this.state === 'listening' ? 2400 : 3400;
    this.nextBlink = now + rate + Math.random() * 2200;
  }

  render() {
    const gl = this.gl;
    const mesh = this.mesh;
    const canvas = this.canvas;
    if (!gl || !mesh || !canvas) return;
    if (!this.view) this.resize();
    const w = canvas.width, h = canvas.height;
    const iw = mesh.w || this.image.naturalWidth || 1;
    const ih = mesh.h || this.image.naturalHeight || 1;
    const focusY = (this.view.w > this.view.h * 1.05) ? 0.40 : 0.18;
    const cover = coverOf(w, h, iw, ih, 0.5, focusY);
    const time = performance.now() / 1000;
    const swayX = Math.sin(time * 0.65) * 0.35 + Math.sin(time * 0.17) * 0.2;
    const swayY = Math.sin(time * 0.5) * 0.22 + Math.sin(time * 1.15) * 0.08;
    const tiltX = this.tilt.x * 1.1;
    const tiltY = this.tilt.y * 0.8;
    const shift = [(swayX + tiltX) * 0.008, (swayY + tiltY) * 0.008];
    gl.useProgram(this.program);
    gl.uniform2f(this.loc.face, mesh.nose[0], mesh.nose[1]);
    gl.uniform2f(this.loc.shift, shift[0], shift[1]);
    gl.uniform1f(this.loc.mask, 0);
    this.drawPlate(cover, 1);
    gl.uniform1f(this.loc.mask, 1);
    gl.uniform2f(this.loc.shift, shift[0] * 1.35, shift[1] * 1.45);
    this.drawPlate(cover, 1);
    gl.uniform1f(this.loc.mask, 0);
    gl.uniform2f(this.loc.shift, shift[0], shift[1]);
    this.drawFace(cover, shift);
  }

  drawPlate(cover, shade) {
    const gl = this.gl;
    const x0 = cover.x0, x1 = cover.x1, y0 = cover.y0, y1 = cover.y1;
    const data = new Float32Array([
      -1, 1, x0, y0, shade,
      1, 1, x1, y0, shade,
      -1, -1, x0, y1, shade,
      1, -1, x1, y1, shade
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.plateBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.bindAttribs(5);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  drawFace(cover, shift) {
    const gl = this.gl;
    const mesh = this.mesh;
    const xy = mesh.xy;
    const role = mesh.role;
    const nose = mesh.nose;
    const open = this.eased.open;
    const wide = this.eased.wide;
    const round = this.eased.round;
    const smile = this.expr.smile;
    const concern = this.expr.concern;
    const brow = this.expr.brow;
    const gazeX = this.expr.gazeX * 0.004;
    const gazeY = this.expr.gazeY * 0.003;
    const n = role.length;
    const data = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
      const x = xy[i * 2], y = xy[i * 2 + 1];
      const kind = role[i];
      let dx = 0, dy = 0;
      const side = x < nose[0] ? -1 : 1;
      if (kind === 1) {
        dy -= Math.max(0, open) * 0.014 + Math.min(0, open) * 0.010;
        dx += side * wide * 0.010 - side * round * 0.012;
      } else if (kind === 2) {
        dy += Math.max(0, open) * 0.032 + Math.min(0, open) * 0.020;
        dx += side * wide * 0.008 - side * round * 0.010;
      } else if (kind === 3) {
        dx += side * wide * 0.022 - side * round * 0.026;
        dy += Math.max(0, open) * 0.008 + Math.min(0, open) * 0.012;
        dy -= smile * 0.008;
        dy += concern * 0.006;
      } else if (kind === 9) {
        dy += Math.max(0, open) * 0.016 + Math.min(0, open) * 0.008;
      } else if (kind === 10) {
        dy += open * 0.005;
        dx += side * wide * 0.004;
      } else if (kind === 5) {
        dy += this.blink * 0.016;
      } else if (kind === 6) {
        dy -= this.blink * 0.004;
      } else if (kind === 7) {
        dx += gazeX * 2.2;
        dy += gazeY * 2.2;
      } else if (kind === 8) {
        dy -= brow * 0.008;
        dx += -side * concern * 0.004;
      } else if (kind === 4) {
        dy -= smile * 0.005;
        dx += side * smile * 0.003;
      }
      const depth = depthAt(x, y, nose[0], nose[1]);
      const sx = x + dx - shift[0] * depth;
      const sy = y + dy - shift[1] * depth;
      const clip = imageToClip(sx, sy, cover);
      const shade = 1 - Math.max(0, open) * ((kind === 1 || kind === 2 || kind === 3) ? 0.07 : 0);
      const o = i * 5;
      data[o] = clip[0];
      data[o + 1] = clip[1];
      data[o + 2] = x;
      data[o + 3] = y;
      data[o + 4] = shade;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.bindAttribs(5);
    const index = this.indexBuf || (this.indexBuf = gl.createBuffer());
    if (!this.indexReady) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.tris), gl.STATIC_DRAW);
      this.indexReady = true;
    } else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.drawElements(gl.TRIANGLES, mesh.tris.length, gl.UNSIGNED_SHORT, 0);
  }

  bindAttribs(stride) {
    const gl = this.gl;
    const bytes = stride * 4;
    gl.enableVertexAttribArray(this.loc.clip);
    gl.enableVertexAttribArray(this.loc.img);
    gl.enableVertexAttribArray(this.loc.shade);
    gl.vertexAttribPointer(this.loc.clip, 2, gl.FLOAT, false, bytes, 0);
    gl.vertexAttribPointer(this.loc.img, 2, gl.FLOAT, false, bytes, 8);
    gl.vertexAttribPointer(this.loc.shade, 1, gl.FLOAT, false, bytes, 16);
  }

  diagnostics() {
    const canvas = this.canvas;
    let webgl = 'none';
    let lost = false;
    try {
      const gl = this.gl;
      if (gl && !gl.isContextLost()) webgl = 'webgl';
      lost = !!(gl && gl.isContextLost && gl.isContextLost());
    } catch (e) {}
    return {
      running: this.running,
      audio: this.ctx ? this.ctx.state : 'none',
      css: canvas ? Math.round(canvas.clientWidth) + 'x' + Math.round(canvas.clientHeight) : '0x0',
      buffer: canvas ? canvas.width + 'x' + canvas.height : '0x0',
      webgl,
      lost,
      error: this.lastError || '',
      mouth: this.pose.viseme,
      open: Math.round(this.pose.open * 100) / 100
    };
  }

  dispose() {
    this.stop();
    this.interrupt();
    if (this._tiltBound) window.removeEventListener('deviceorientation', this._tiltBound);
    if (this.node) this.node.replaceChildren();
    const gl = this.gl;
    if (gl) { try { gl.deleteTexture(this.tex); } catch (e) {} }
    this.gl = null;
  }
}

function planFrom(input) {
  if (input.visemes && input.visemes.length) {
    return { visemes: input.visemes, vtimes: input.vtimes || [], vdurations: input.vdurations || [] };
  }
  const words = input.words || [];
  const visemes = [];
  const vtimes = [];
  const vdurations = [];
  words.forEach((word, i) => {
    const plan = fillVisemes(wordPlan(word, 1), null);
    const span = (input.wdurations && input.wdurations[i]) || 160;
    const total = Math.max(1, plan.total || span);
    const start = (input.wtimes && input.wtimes[i]) || 0;
    plan.visemes.forEach((name, j) => {
      visemes.push(name);
      vtimes.push(start + (plan.vtimes[j] / total) * span);
      vdurations.push(Math.max(36, (plan.vdurations[j] / total) * span));
    });
  });
  return { visemes, vtimes, vdurations };
}

function depthAt(x, y, nx, ny) {
  const ax = Math.abs(x - nx) / 0.11;
  const ay = Math.abs(y - ny) / 0.30;
  const t = Math.min(1, Math.sqrt(ax * ax + ay * ay));
  return (1 - t) * (1 - t);
}

function coverOf(cw, ch, iw, ih, focusX, focusY) {
  const scale = Math.max(cw / iw, ch / ih);
  const shownW = cw / scale;
  const shownH = ch / scale;
  const originX = (iw - shownW) * focusX;
  const originY = (ih - shownH) * focusY;
  return {
    x0: originX / iw,
    x1: (originX + shownW) / iw,
    y0: originY / ih,
    y1: (originY + shownH) / ih,
    scale, originX, originY, iw, ih, cw, ch
  };
}

function imageToClip(x, y, cover) {
  const px = x * cover.iw;
  const py = y * cover.ih;
  const sx = (px - cover.originX) * cover.scale;
  const sy = (py - cover.originY) * cover.scale;
  return [(sx / cover.cw) * 2 - 1, 1 - (sy / cover.ch) * 2];
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Portrait photo failed'));
    img.src = url;
  });
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'Shader failed');
  }
  return shader;
}
