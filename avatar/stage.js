// Lazy 3D stage. Loaded only after the dashboard has painted.
// TalkingHead (MIT) drives blinks, saccades, breathing, and visemes.
// Speech audio stays in speechSynthesis. This stage plays a silent buffer
// so the mouth timeline runs without a second voice.

import { TalkingHead } from 'talkinghead';
import { LipsyncEn } from 'lipsync-en';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Character } from './character.js';

const MODEL = new URL('./models/amara.glb', import.meta.url).href;
const DRACO = new URL('./draco/', import.meta.url).href;

const setDecoderPath = DRACOLoader.prototype.setDecoderPath;
DRACOLoader.prototype.setDecoderPath = function (path) {
  const out = setDecoderPath.call(this, path);
  this.workerLimit = 1;
  return out;
};

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
  const model = options.modelUrl || (options.profile && options.profile.avatarModel) || MODEL;
  await character.load({
    url: new URL(model, document.baseURI).href,
    body: options.body || (options.profile && options.profile.body) || 'F',
    onprogress: options.onProgress
  });
  if (head.scene) head.scene.background = new THREE.Color(0x14110c);
  character.setState('idle');
  character.kick();
  if (node) node.__character = character;
  return character;
  } catch (err) {
    try { if (head && head.dispose) head.dispose(); } catch (e) {}
    if (node) node.replaceChildren();
    throw err;
  }
}
