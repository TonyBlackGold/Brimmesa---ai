// Common character API. The TalkingHead instance is injected so this file
// does not load WebGL by itself. Full-body clip and environment slots stay
// empty until a later phase has Mixamo clips and a scene.

import { fillVisemes, shiftPlan, wordIndex, wordPlan } from './lipsync.js';

const HANDS = {
  'playful hands': ['handup', 'ok', 'thumbup'],
  'point': ['index'],
  'shrug': ['shrug'],
  'impatient': ['index', 'thumbdown'],
  'open hands': ['handup', 'side']
};

export function gesturePool(mannerisms, gestureRate) {
  const notes = (mannerisms || []).map(s => String(s).toLowerCase());
  if (notes.some(s => s.includes('still hands'))) return [];
  const pool = [];
  Object.keys(HANDS).forEach(key => {
    if (notes.some(s => s.includes(key))) pool.push(...HANDS[key]);
  });
  if (!pool.length && gestureRate > 0.65) pool.push('handup', 'index');
  return pool;
}

export class Character {
  constructor(head, lipsync, profile) {
    this.head = head;
    this.lipsync = lipsync || null;
    this.profile = profile || {};
    this.state = 'idle';
    this.session = 0;
    this.plan = null;
    this.realigns = 0;
    this.visible = true;
    this.gestureTimer = 0;
    this.slots = {
      rig: 'mixamo-talkinghead',
      cameraView: 'upper',
      environment: null,
      clips: { idle: null, listen: null, speak: null, think: null }
    };
    this.pool = gesturePool(this.profile.mannerisms, this.profile.gestureRate || 0);
    this.nods = (this.profile.mannerisms || []).some(s => /nod/i.test(s));
  }

  applyPersonality() {
    const express = clamp(this.profile.expressiveness, 0.45);
    const rate = clamp(this.profile.gestureRate, 0.35);
    const opt = this.head.opt;
    opt.avatarIdleEyeContact = 0.18 + express * 0.55;
    opt.avatarSpeakingEyeContact = 0.4 + express * 0.5;
    opt.avatarIdleHeadMove = 0.12 + rate * 0.4;
    opt.avatarSpeakingHeadMove = 0.16 + rate * 0.65;
    opt.modelMovementFactor = 0.55 + express * 0.7;
    opt.lipsyncLang = 'en';
  }

  async load(model) {
    const url = typeof model === 'string' ? model : model && model.url;
    if (!url) throw new Error('Character.load needs a model url');
    const body = (model && model.body) || this.profile.body || 'F';
    const onprogress = model && model.onprogress;
    await this.head.showAvatar({
      url,
      body,
      avatarMood: 'neutral',
      lipsyncLang: 'en'
    }, (ev) => {
      if (typeof onprogress !== 'function' || !ev || !ev.total) return;
      onprogress(Math.max(0, Math.min(100, Math.round(100 * ev.loaded / ev.total))));
    });
    this.modelUrl = url;
    this.applyPersonality();
    this.head.setMixerGain(0, 0);
    this.head.setView(this.slots.cameraView);
    if (this.head.scene && this.head.scene.background == null && this.color) {
      this.head.scene.background = this.color;
    }
    this.armGestures();
    return this;
  }

  setProfile(profile) {
    this.profile = profile || {};
    this.pool = gesturePool(this.profile.mannerisms, this.profile.gestureRate || 0);
    this.nods = (this.profile.mannerisms || []).some(s => /nod/i.test(s));
    if (this.head && this.head.armature) this.applyPersonality();
  }

  setView(view) {
    if (view !== 'full' && view !== 'mid' && view !== 'upper' && view !== 'head') return;
    this.slots.cameraView = view;
    if (this.head) this.head.setView(view);
  }

  setEnvironment(url) {
    this.slots.environment = url || null;
  }

  setClip(name, url) {
    if (this.slots.clips.hasOwnProperty(name)) this.slots.clips[name] = url || null;
  }

  speak(input, opt) {
    opt = opt || {};
    try { this.speakNow(input, opt); } catch (e) {}
  }

  speakNow(input, opt) {
    if (!this.head || !this.head.armature) {
      this.lastError = '3D rig is not loaded';
      return;
    }
    if (this.head.audioCtx && this.head.audioCtx.state !== 'running') {
      const pending = this.head.audioCtx.resume();
      if (pending && pending.catch) pending.catch(() => {});
    }
    if (input && typeof input === 'object' && (input.audio || input.visemes)) {
      this.session++;
      this.realigns = 0;
      this.plan = null;
      if (opt.emotion) this.react(opt.emotion);
      const audible = !!(input.audio && input.audible !== false);
      this.head.setMixerGain(audible ? 1 : 0, 0);
      this.head.speakAudio(input, { lipsyncLang: 'en' });
      return;
    }
    const text = String(input || '').trim();
    if (!text) return;
    const plan = wordPlan(text, opt.rate || 1);
    fillVisemes(plan, this.lipsync);
    this.session++;
    this.realigns = 0;
    if (opt.emotion) this.react(opt.emotion);
    this.play(plan);
  }

  bindUtterance(utterance) {
    if (!utterance) return;
    const session = this.session;
    const plan = this.plan;
    utterance.onboundary = ev => {
      if (session !== this.session || !plan) return;
      this.realign(ev, plan);
    };
  }

  realign(ev, plan) {
    if (!ev || (ev.name && ev.name !== 'word')) return;
    if (typeof ev.elapsedTime !== 'number') return;
    if (ev.elapsedTime === 0 && ev.charIndex > 0) return;
    if (this.realigns >= 2) return;
    const idx = wordIndex(plan.spans, ev.charIndex || 0);
    if (idx < 0) return;
    const drift = ev.elapsedTime - plan.wtimes[idx];
    if (Math.abs(drift) < 180) return;
    this.realigns++;
    this.play(shiftPlan(plan, idx));
  }

  play(plan) {
    this.plan = plan;
    if (!plan.visemes.length) return;
    const session = this.session;
    this.queuePlay(plan, session);
  }

  async queuePlay(plan, session) {
    try {
      if (session !== this.session) return;
      this.head.stopSpeaking();
      const ctx = this.head.audioCtx;
      if (ctx && ctx.state === 'suspended') await ctx.resume();
      if (session !== this.session) return;
      this.head.setMixerGain(0, 0);
      const ms = Math.max(240, plan.total);
      const sr = (ctx && ctx.sampleRate) || 48000;
      const audio = ctx.createBuffer(1, Math.max(1, Math.ceil(sr * ms / 1000)), sr);
      this.head.speakAudio({
        audio,
        words: plan.words.length ? plan.words : [' '],
        wtimes: plan.wtimes.length ? plan.wtimes : [0],
        wdurations: plan.wdurations.length ? plan.wdurations : [ms],
        visemes: plan.visemes,
        vtimes: plan.vtimes,
        vdurations: plan.vdurations
      }, { lipsyncLang: 'en' });
    } catch (e) {}
  }

  setState(state) {
    const next = state === 'listening' || state === 'speaking' || state === 'thinking' ? state : 'idle';
    this.state = next;
    if (!this.head || !this.head.armature) return;
    if (next === 'listening') {
      try { this.head.stopSpeaking(); } catch (e) {}
      this.safeMood('neutral');
      this.head.lookAtCamera(400);
      this.head.makeEyeContact(6000);
    } else if (next === 'thinking') {
      try { this.head.stopSpeaking(); } catch (e) {}
      this.head.lookAhead(1600);
    } else if (next === 'speaking') {
      this.head.lookAtCamera(280);
      this.head.makeEyeContact(2000);
    } else {
      try { this.head.stopSpeaking(); } catch (e) {}
      this.head.lookAtCamera(700);
    }
    this.maybeClip(next);
  }

  interrupt() {
    this.session++;
    this.plan = null;
    this.realigns = 0;
    if (!this.head) return;
    try { this.head.stopSpeaking(); } catch (e) {}
  }

  react(emotion) {
    if (!this.head || !this.head.armature || !emotion) return;
    if (emotion === 'laugh' || emotion === 'smile') {
      this.safeMood('happy');
      if (emotion === 'laugh' && this.pool.length) {
        const name = this.pool[Math.floor(Math.random() * this.pool.length)];
        this.head.playGesture(name, 1.6 + Math.random() * 1.2, Math.random() < 0.5, 420);
      }
    } else if (emotion === 'concern') {
      this.safeMood('sad');
    } else if (emotion === 'surprise') {
      this.pulse(['eyeWideLeft', 'eyeWideRight', 'browInnerUp'], 0.7, 1100);
      this.head.lookAtCamera(200);
    }
  }

  lookAt(target) {
    if (!this.head || !this.head.armature) return;
    if (target == null || target === 'camera' || target === 'user') this.head.lookAtCamera(600);
    else if (target === 'ahead') this.head.lookAhead(1200);
    else if (typeof target === 'object') {
      const x = Math.max(-1, Math.min(1, target.x || 0));
      const y = Math.max(-1, Math.min(1, target.y || 0));
      this.head.setValue('eyesRotateY', x, 280);
      this.head.setValue('eyesRotateX', y, 280);
    }
  }

  viseme(name) {
    if (!this.head || !name) return;
    const key = String(name).startsWith('viseme_') ? String(name) : 'viseme_' + name;
    this.head.setValue(key, 0.7, 50);
    setTimeout(() => { if (this.head) this.head.setValue(key, null); }, 140);
  }

  setVisible(on) {
    this.visible = !!on;
    if (!this.head) return;
    if (this.visible) this.head.start();
    else this.head.stop();
  }

  audioContext() {
    return this.head && this.head.audioCtx;
  }

  resume() {
    if (this.head && this.head.audioCtx && this.head.audioCtx.state !== 'running') {
      this.head.audioCtx.resume().catch(err => {
        this.lastError = 'audio ' + (err && err.message ? err.message : 'suspended');
      });
    }
  }

  kick() {
    if (!this.head) return;
    this.resume();
    try {
      if (this.head.armature && this.head.isRunning === false) this.head.start();
      const node = this.head.nodeAvatar;
      const renderer = this.head.renderer;
      if (node && renderer) {
        const w = Math.max(2, node.clientWidth || 0);
        const h = Math.max(2, node.clientHeight || 0);
        renderer.setSize(w, h, false);
        if (this.head.camera) {
          this.head.camera.aspect = w / h;
          this.head.camera.updateProjectionMatrix();
        }
        if (typeof this.head.render === 'function') this.head.render();
      }
    } catch (e) {
      this.lastError = e && e.message ? e.message : String(e);
    }
  }

  diagnostics() {
    const canvas = this.head && this.head.renderer && this.head.renderer.domElement;
    let webgl = 'none';
    let lost = false;
    try {
      const gl = this.head && this.head.renderer && this.head.renderer.getContext();
      if (gl) {
        webgl = gl.constructor && gl.constructor.name === 'WebGL2RenderingContext' ? 'webgl2' : 'webgl';
        lost = !!(gl.isContextLost && gl.isContextLost());
      }
    } catch (e) {}
    return {
      running: !!(this.head && this.head.isRunning),
      audio: this.head && this.head.audioCtx ? this.head.audioCtx.state : 'none',
      css: canvas ? Math.round(canvas.clientWidth) + 'x' + Math.round(canvas.clientHeight) : '0x0',
      buffer: canvas ? canvas.width + 'x' + canvas.height : '0x0',
      webgl,
      lost,
      error: this.lastError || ''
    };
  }

  armGestures() {
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    const tick = () => {
      const rate = clamp(this.profile.gestureRate, 0.35);
      const wait = 1800 + (1 - rate) * 5200 + Math.random() * 3600;
      this.gestureTimer = setTimeout(() => {
        if (this.visible && this.head && this.head.armature && this.state === 'speaking') {
          if (this.nods && Math.random() < 0.55) this.nod();
          else if (this.pool.length && Math.random() < 0.35 + rate * 0.55) {
            const name = this.pool[Math.floor(Math.random() * this.pool.length)];
            this.head.playGesture(name, 1.3 + Math.random() * 2.1, Math.random() < 0.5, 380 + Math.random() * 640);
          }
        }
        tick();
      }, wait);
    };
    tick();
  }

  nod() {
    const amount = 0.08 + Math.random() * 0.08;
    this.head.setValue('headRotateX', amount, 160);
    setTimeout(() => { if (this.head) this.head.setValue('headRotateX', null); }, 380 + Math.random() * 180);
  }

  pulse(names, value, hold) {
    names.forEach(name => this.head.setValue(name, value, 160));
    setTimeout(() => names.forEach(name => { if (this.head) this.head.setValue(name, null); }), hold);
  }

  safeMood(name) {
    try { this.head.setMood(name); } catch (e) {}
  }

  async maybeClip(state) {
    const key = state === 'listening' ? 'listen' : state === 'speaking' ? 'speak' : state === 'thinking' ? 'think' : 'idle';
    const url = this.slots.clips[key];
    if (!url || !this.head) return;
    try { await this.head.playAnimation(url); } catch (e) {}
  }

  dispose() {
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    this.gestureTimer = 0;
    const head = this.head;
    this.head = null;
    try { if (head && head.dispose) head.dispose(); } catch (e) {}
  }
}

function clamp(n, fallback) {
  const v = typeof n === 'number' ? n : fallback;
  return Math.max(0, Math.min(1, v));
}
