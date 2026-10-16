// Lazy 3D stage. Loaded only after the dashboard has painted.
// TalkingHead (MIT) drives blinks, saccades, breathing, and visemes.
// A finished GLB download is not a finished avatar: Draco decode and
// skeleton setup run after the progress event hits 100%. Those steps
// have a timeout so a hung worker cannot leave the portrait up forever.

import { TalkingHead } from 'talkinghead';
import { LipsyncEn } from 'lipsync-en';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Character } from './character.js';

const MODEL = new URL('./models/amara.glb', import.meta.url).href;
const DRACO = new URL('./draco/', import.meta.url).href;

function setupMs() {
  const n = typeof window !== 'undefined' ? Number(window.__BRIM_SETUP_MS) : 0;
  return n > 0 ? n : 90000;
}

function decodeMs() {
  const n = typeof window !== 'undefined' ? Number(window.__BRIM_SETUP_MS) : 0;
  return n > 0 ? n : 25000;
}

function asError(err, fallback) {
  if (err instanceof Error && err.message) return err;
  if (typeof err === 'string' && err) return new Error(err);
  const raw = err && (err.message || err.error || err.statusText);
  if (raw) return new Error(String(raw));
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}' && json !== 'null') return new Error(json);
  } catch (e) {}
  return new Error(fallback || 'unknown error');
}

function withStep(err, phase) {
  const error = asError(err, '3D setup failed after the model downloaded');
  if (!/last step/i.test(error.message)) error.message += '. Last step: ' + phase;
  return error;
}

function rejectPending(worker, err) {
  const cbs = worker && worker._callbacks;
  if (!cbs) return;
  Object.keys(cbs).forEach(id => {
    const cb = cbs[id];
    if (cb && typeof cb.reject === 'function') {
      try { cb.reject(err); } catch (e) {}
    }
  });
}

let activeDraco = null;
const setDecoderPath = DRACOLoader.prototype.setDecoderPath;
DRACOLoader.prototype.setDecoderPath = function (path) {
  activeDraco = this;
  const out = setDecoderPath.call(this, path);
  this.workerLimit = 1;
  return out;
};

const decodeGeometry = DRACOLoader.prototype.decodeGeometry;
DRACOLoader.prototype.decodeGeometry = function (buffer, taskConfig) {
  let pending;
  try {
    pending = decodeGeometry.call(this, buffer, taskConfig);
  } catch (err) {
    return Promise.reject(asError(err, 'Draco decoder failed'));
  }
  let timer = 0;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Draco decoder timed out after the model downloaded');
      const pool = this.workerPool || [];
      pool.forEach(worker => {
        rejectPending(worker, err);
        try { worker.terminate(); } catch (e) {}
      });
      if (this.workerPool) this.workerPool.length = 0;
      reject(err);
    }, decodeMs());
    Promise.resolve(pending).then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(asError(err, 'Draco decoder failed')); }
    );
  });
};

const getWorker = DRACOLoader.prototype._getWorker;
DRACOLoader.prototype._getWorker = function (taskID, taskCost) {
  return getWorker.call(this, taskID, taskCost).then(worker => {
    if (worker && !worker.__brimmesaWatch) {
      worker.__brimmesaWatch = true;
      const raw = worker.onmessage;
      worker.onmessage = function (e) {
        const message = e && e.data;
        if (message && message.type === 'error') {
          const why = message.error || message.message || 'Draco decoder failed';
          const cb = worker._callbacks && worker._callbacks[message.id];
          if (cb && cb.reject) cb.reject(new Error(typeof why === 'string' ? why : 'Draco decoder failed'));
          return;
        }
        try {
          if (raw) raw.call(worker, e);
        } catch (err) {
          rejectPending(worker, asError(err, 'Draco decoder failed'));
        }
      };
      worker.addEventListener('error', ev => {
        const msg = (ev && (ev.message || (ev.error && ev.error.message))) || 'Draco worker crashed';
        rejectPending(worker, new Error(String(msg)));
      });
    }
    return worker;
  });
};

function releaseDraco() {
  try { if (activeDraco && activeDraco.dispose) activeDraco.dispose(); } catch (e) {}
  activeDraco = null;
}

export async function mount(node, options) {
  options = options || {};
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const dpr = window.devicePixelRatio || 1;
  const targetRatio = coarse ? 1 : Math.min(1.5, dpr);
  if (node) node.replaceChildren();
  let head = null;
  try {
  head = new TalkingHead(node, {
    lipsyncLang: 'en',
    lipsyncModules: ['en'],
    cameraView: 'upper',
    cameraDistance: -1.3,
    cameraRotateEnable: false,
    cameraPanEnable: false,
    cameraZoomEnable: false,
    dracoEnabled: true,
    dracoDecoderPath: DRACO,
    mixerGainSpeech: 0,
    mixerGainBackground: 0,
    modelPixelRatio: targetRatio / dpr,
    modelFPS: 30,
    lightAmbientColor: 0xfff4e4,
    lightAmbientIntensity: 1.6,
    lightDirectColor: 0xffe2b0,
    lightDirectIntensity: 22,
    avatarMood: 'neutral',
    avatarMute: false
  });
  const rawPlay = head.playAudio.bind(head);
  head.playAudio = async function (force) {
    const ctx = this.audioCtx;
    if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
      try {
        await Promise.race([
          ctx.resume(),
          new Promise(resolve => setTimeout(resolve, 400))
        ]);
      } catch (e) {}
      if (ctx.state !== 'running') {
        const item = this.audioPlaylist && this.audioPlaylist[0];
        if (item && item.anim) {
          this.audioPlaylist.shift();
          item.anim.forEach(entry => {
            if (entry.ts) entry.ts = entry.ts.map(t => this.animClock + t);
            this.animQueue.push(entry);
          });
        }
        this.isAudioPlaying = false;
        this.isSpeaking = true;
        return;
      }
    }
    return rawPlay(force);
  };
  if (head.scene) head.scene.background = new THREE.Color(0x14110c);
  const character = new Character(head, new LipsyncEn(), options.profile || null);
  character.color = new THREE.Color(0x14110c);
  const canvas = head.renderer && head.renderer.domElement;
  if (canvas) {
    canvas.addEventListener('webglcontextlost', ev => {
      if (ev && ev.preventDefault) ev.preventDefault();
      character.lastError = 'WebGL context lost';
    });
  }
  let phase = 'download';
  const rawShow = head.showAvatar.bind(head);
  head.showAvatar = async function (avatar, onprogress) {
    if (typeof window !== 'undefined' && window.__BRIM_HANG_SETUP) {
      if (typeof onprogress === 'function') onprogress({ loaded: 1, total: 1 });
      return new Promise(() => {});
    }
    if (typeof window !== 'undefined' && window.__BRIM_THROW_SETUP) {
      if (typeof onprogress === 'function') onprogress({ loaded: 1, total: 1 });
      await Promise.resolve();
      throw window.__BRIM_THROW_SETUP;
    }
    try {
      const out = await rawShow(avatar, onprogress);
      phase = 'skeleton';
      if (typeof options.onProgress === 'function') options.onProgress(100, phase);
      return out;
    } catch (err) {
      throw withStep(err, phase);
    }
  };
  const model = options.modelUrl || (options.profile && options.profile.avatarModel) || MODEL;
  let timer = 0;
  let overall = 0;
  const loaded = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(overall);
      if (ok) resolve(value);
      else reject(value);
    };
    const arm = () => {
      if (timer || settled) return;
      timer = setTimeout(() => {
        finish(false, new Error('3D setup timed out after the model downloaded. Last step: ' + phase));
      }, setupMs());
    };
    overall = setTimeout(() => {
      finish(false, new Error('3D setup timed out. Last step: ' + phase));
    }, Math.max(setupMs() * 4, 120000));
    character.load({
      url: new URL(model, document.baseURI).href,
      body: options.body || (options.profile && options.profile.body) || 'F',
      onprogress: pct => {
        if (pct >= 100 && phase === 'download') {
          phase = 'decoder';
          arm();
        }
        if (typeof options.onProgress === 'function') options.onProgress(pct, phase);
      }
    }).then(
      value => finish(true, value),
      err => finish(false, withStep(err, phase))
    );
  });
  const ready = await loaded;
  phase = 'reveal';
  if (typeof options.onProgress === 'function') options.onProgress(100, phase);
  if (typeof options.onReady === 'function') {
    try { options.onReady(ready); } catch (e) { ready.lastError = asError(e).message; }
  }
  try {
    if (head.scene) head.scene.background = new THREE.Color(0x14110c);
    ready.setState('idle');
    ready.kick();
  } catch (e) {
    ready.lastError = asError(e).message;
  }
  if (node) node.__character = ready;
  return ready;
  } catch (err) {
    releaseDraco();
    try { if (head && head.dispose) head.dispose(); } catch (e) {}
    if (node) node.replaceChildren();
    throw withStep(err, 'setup');
  }
}
