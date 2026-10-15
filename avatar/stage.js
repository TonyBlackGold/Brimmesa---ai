// Lazy 3D stage. Loaded only after the dashboard has painted.
// TalkingHead (MIT) drives blinks, saccades, breathing, and visemes.
// Speech audio stays in speechSynthesis. This stage plays a silent buffer
// so the mouth timeline runs without a second voice.

import { TalkingHead } from 'talkinghead';
import { LipsyncEn } from 'lipsync-en';
import * as THREE from 'three';
import { Character } from './character.js';

const MODEL = new URL('./models/amara.glb', import.meta.url).href;

export async function mount(node, options) {
  options = options || {};
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const head = new TalkingHead(node, {
    lipsyncLang: 'en',
    lipsyncModules: ['en'],
    cameraView: 'upper',
    cameraDistance: -1.3,
    cameraRotateEnable: false,
    cameraPanEnable: false,
    cameraZoomEnable: false,
    dracoEnabled: true,
    dracoDecoderPath: 'https://www.gstatic.com/draco/v1/decoders/',
    mixerGainSpeech: 0,
    mixerGainBackground: 0,
    modelPixelRatio: coarse ? 1 : Math.min(1.5, window.devicePixelRatio || 1),
    modelFPS: coarse ? 24 : 30,
    lightAmbientColor: 0xfff4e4,
    lightAmbientIntensity: 1.6,
    lightDirectColor: 0xffe2b0,
    lightDirectIntensity: 22,
    avatarMood: 'neutral',
    avatarMute: true
  });
  if (head.scene) head.scene.background = new THREE.Color(0x14110c);
  const character = new Character(head, new LipsyncEn(), options.profile || null);
  character.color = new THREE.Color(0x14110c);
  const model = options.modelUrl || (options.profile && options.profile.avatarModel) || MODEL;
  await character.load({ url: new URL(model, document.baseURI).href, body: options.body || 'F' });
  if (head.scene) head.scene.background = new THREE.Color(0x14110c);
  character.setState('idle');
  return character;
}
