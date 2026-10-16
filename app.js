// Browser shell: dashboard, speech in/out, portraits. Logic lives in engine.js.
(async function () {
  const KEY = 'brimmesa.profile.v1';
  const GEMINI_KEY = 'brimmesa.gemini.key';
  const GEMINI_MODEL = 'brimmesa.gemini.model';
  const GEMINI_USAGE = 'brimmesa.gemini.usage';
  const GEMINI_TURNS = 'brimmesa.gemini.turns';
  const GEMINI_TTS = 'brimmesa.gemini.tts';
  const ELEVEN_KEY = 'brimmesa.eleven.key';
  const ELEVEN_VOICES = 'brimmesa.eleven.voices';
  const ELEVEN_USAGE = 'brimmesa.eleven.usage';
  const GEMINI_DEFAULT = 'gemini-3.5-flash-lite';
  const $ = id => document.getElementById(id);
  const worlds = await (await fetch('data/worlds.json')).json();
  const areasDoc = await (await fetch('data/areas.json')).json();
  const castDoc = await (await fetch('data/characters.json')).json();
  const areas = areasDoc.areas;
  const cast = castDoc.characters;
  const content = {};
  for (const w of worlds.worlds) for (const a of w.activities) content[a.id] = await (await fetch(a.file)).json();

  const chars = { coach: { name: worlds.coach.name, voice: worlds.coach.voice, color: '#e0b65a' }, user: { name: 'You', color: '#c9a24a' } };
  const palette = ['#e0b65a', '#d7a15a', '#c4b49a', '#8d6428'];
  Object.values(content).forEach(c => (c.characters || []).forEach((ch, i) => chars[ch.id] = { ...ch, color: palette[(ch.voice.index || i) % palette.length] }));
  const portraitOf = speaker => {
    const row = cast.find(c => c.speakerId === speaker || (speaker === 'coach' && c.id === 'amara'));
    return row && row.portrait;
  };
  cast.forEach(c => document.querySelectorAll('[data-portrait="' + c.id + '"]').forEach(img => { img.src = c.portrait; }));

  const profile = JSON.parse(localStorage.getItem(KEY) || 'null') || BrimEngine.newProfile();
  const eng = new BrimEngine.Engine({ worlds, content, profile, areas });
  if (!eng.p.name) eng.mode = 'askname';
  function readJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  const llm = BrimEngine.createLLMProvider({
    enabled: !!localStorage.getItem(GEMINI_KEY),
    getKey() { return localStorage.getItem(GEMINI_KEY) || ''; },
    getModel() { return localStorage.getItem(GEMINI_MODEL) || GEMINI_DEFAULT; },
    getCast() { return cast; },
    readUsage() { return readJSON(GEMINI_USAGE, { day: '', count: 0 }); },
    writeUsage(u) { localStorage.setItem(GEMINI_USAGE, JSON.stringify({ day: u.day, count: u.count })); },
    readMemory() { return readJSON(GEMINI_TURNS, []); },
    writeMemory(m) { localStorage.setItem(GEMINI_TURNS, JSON.stringify((m || []).slice(-10))); }
  });
  if (llm.enabled) eng.provider = llm;
  const ttsCache = new Map();
  function openTtsDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('no idb'));
      const req = indexedDB.open('brimmesa-tts', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('clips')) req.result.createObjectStore('clips'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function cacheGet(key) {
    if (ttsCache.has(key)) return ttsCache.get(key);
    try {
      const db = await openTtsDb();
      const bytes = await new Promise((resolve, reject) => {
        const req = db.transaction('clips').objectStore('clips').get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (bytes) ttsCache.set(key, bytes);
      return bytes;
    } catch (e) { return null; }
  }
  async function cacheSet(key, bytes) {
    ttsCache.set(key, bytes);
    if (ttsCache.size > 30) {
      const oldest = ttsCache.keys().next().value;
      ttsCache.delete(oldest);
    }
    try {
      const db = await openTtsDb();
      await new Promise((resolve, reject) => {
        const req = db.transaction('clips', 'readwrite').objectStore('clips').put(bytes, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {}
  }
  const speaker = BrimSpeech.createSpeaker({
    getKey() { return localStorage.getItem(GEMINI_KEY) || ''; },
    now() { return Date.now(); },
    readUsage() { return readJSON(GEMINI_TTS, { day: '', count: 0 }); },
    writeUsage(u) { localStorage.setItem(GEMINI_TTS, JSON.stringify({ day: u.day, count: u.count })); },
    cacheGet,
    cacheSet
  });
  const eleven = BrimSpeech.createEleven({
    getKey() { return localStorage.getItem(ELEVEN_KEY) || ''; },
    readUsage() { return readJSON(ELEVEN_USAGE, null); },
    writeUsage(u) { localStorage.setItem(ELEVEN_USAGE, JSON.stringify({ tier: u.tier || '', character_count: u.character_count || 0, character_limit: u.character_limit || 0 })); },
    cacheGet,
    cacheSet
  });

  const BLURB = {
    'spice-aisle': 'Two people in the aisle. Practice a warm, respectful conversation.',
    interruptions: 'Marcus cuts in. Hold your point without heat.',
    'secplus-701': 'Original Security+ practice. Not an official exam.'
  };
  const ICONS = {
    mindset: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M8 13c1-2 2-3 4-3s3 1 4 3"/><path d="M9 10h.01M15 10h.01"/></svg>',
    health: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M6 9h3l1-3 2 8 2-5h4"/></svg>',
    career: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5h8v2"/></svg>',
    business: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M4 16l5-5 3 3 7-7"/><path d="M14 7h6v6"/></svg>',
    relationships: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><circle cx="8" cy="9" r="2.2"/><circle cx="16" cy="9" r="2.2"/><path d="M4 18c.6-2.4 2.4-3.5 4-3.5S11.4 15.6 12 18c.6-2.4 2.4-3.5 4-3.5s3.4 1.1 4 3.5"/></svg>',
    estate: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M4 20V10l8-6 8 6v10"/><path d="M10 20v-6h4v6"/></svg>',
    lifestyle: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M3 16l9-6 9 4-4 2"/><path d="M12 10V4"/><path d="M8 20h8"/></svg>',
    spirit: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>'
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name) {
    const span = el('span', 'ico');
    span.innerHTML = ICONS[name] || ICONS.mindset;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  function activityById(id) { return eng.activities().find(a => a.id === id); }
  function levelSpan(xp) {
    const lv = BrimEngine.level(xp);
    const lo = (lv - 1) * (lv - 1) * 50;
    const hi = lv * lv * 50;
    return { lv, t: hi === lo ? 0 : Math.max(0, Math.min(1, (xp - lo) / (hi - lo))) };
  }
  function areaPercent(area) {
    const ids = area.activityIds || [];
    if (ids.length) {
      const scores = ids.map(id => {
        const skill = content[id] && content[id].skill;
        const m = skill && eng.p.mastery[skill];
        return m && m.attempts ? m.best : 0;
      });
      return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }
    const m = area.skill && eng.p.mastery[area.skill];
    return m && m.attempts ? Math.round(m.best) : 0;
  }
  function overallPercent() {
    return areas.length ? Math.round(areas.reduce((sum, area) => sum + areaPercent(area), 0) / areas.length) : 0;
  }

  // Avatar hook. The 3D coach, when it is loaded, follows the same states.
  // state: 'idle' | 'listening' | 'speaking' | 'thinking'.
  function setAvatarState(state, detail) {
    detail = detail || {};
    const speaker = detail.speaker || 'coach';
    const viseme = detail.viseme || '';
    const known = state === 'listening' || state === 'speaking' || state === 'thinking';
    document.body.dataset.voice = known ? state : 'idle';
    document.querySelectorAll('[data-avatar]').forEach(node => {
      const who = node.getAttribute('data-speaker');
      const match = who === speaker || ((speaker === 'coach' || speaker === 'amara') && (who === 'amara' || who === 'coach'));
      if (state === 'idle' || match) {
        node.dataset.state = state === 'idle' || match ? (state === 'idle' ? 'idle' : state) : 'idle';
        if (match && viseme) node.dataset.viseme = viseme;
        else delete node.dataset.viseme;
      } else node.dataset.state = 'idle';
    });
    $('micLabel').textContent = state === 'listening' ? 'Listening' : state === 'speaking' ? 'Speaking' : state === 'thinking' ? 'Thinking' : 'Tap to Talk';
    if (face) {
      const amara = speaker === 'coach' || speaker === 'amara';
      face.setState(amara || state === 'idle' ? (known ? state : 'idle') : 'idle');
      if (amara && viseme) face.viseme(viseme);
    }
  }
  window.setAvatarState = setAvatarState;

  let face = null, facePromise = null, faceFailed = false;
  function avatarPref() { return localStorage.getItem('brimmesa.avatar'); }
  function webglOk() {
    let gl = null;
    try {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      gl = c.getContext('webgl2') || c.getContext('webgl');
      return !!gl;
    } catch (e) { return false; }
    finally {
      try {
        const ext = gl && gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (e) {}
    }
  }
  function want3d() { return avatarPref() !== 'portrait'; }
  function showRetry(on) { if ($('retry3d')) $('retry3d').hidden = !on; }
  function setLoading(pct, phase) {
    const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    const settingUp = n >= 100 || phase === 'decoder' || phase === 'skeleton' || phase === 'reveal';
    if (settingUp) {
      const step = phase === 'skeleton' ? 'skeleton' : phase === 'reveal' ? 'reveal' : 'decoder';
      set3dStatus('setting up ' + step);
      return;
    }
    set3dStatus('loading ' + n + '%');
  }
  function errorText(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    const raw = err.message || err.error || err.statusText || '';
    if (raw) return String(raw);
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch (e) {}
    return String(err);
  }
  function failText(err) {
    const clean = errorText(err).replace(/\s+/g, ' ').trim().slice(0, 180) || 'unknown error';
    if (/webgl/i.test(clean)) return 'Still portrait: WebGL unavailable';
    return 'portrait did not start: ' + clean;
  }
  function set3dStatus(text) {
    const node = $('avatarStatus');
    if (node) node.textContent = 'Portrait status: ' + text;
  }
  function refresh3dStatus() {
    if (!want3d()) { set3dStatus('off, still portrait'); return; }
    if (!face) {
      if (!faceFailed) set3dStatus('loading');
      return;
    }
    let d = { running: false, css: '0x0', buffer: '0x0', webgl: 'none', audio: 'none', lost: false, error: '' };
    try { d = face.diagnostics() || d; } catch (e) { d.error = errorText(e); }
    const bits = [
      d.running ? 'loop on' : 'loop off',
      'canvas ' + d.css,
      'buffer ' + d.buffer,
      d.webgl,
      'audio ' + (d.audio || 'none')
    ];
    if (d.lost) bits.push('context lost');
    if (d.mouth) bits.push('mouth ' + d.mouth);
    if (d.error) bits.push(d.error);
    set3dStatus(bits.join(' · '));
  }
  function showPortrait(reason) {
    $('heroFrame').classList.remove('is-3d');
    document.body.dataset.avatarMode = 'portrait';
    set3dStatus(reason || 'still portrait');
  }
  function revealStage() {
    $('heroFrame').classList.add('is-3d');
    document.body.dataset.avatarMode = '3d';
    showRetry(false);
  }
  function showStage() {
    revealStage();
    try { if (face) face.kick(); } catch (e) { if (face) face.lastError = errorText(e); }
    try { refresh3dStatus(); } catch (e) {}
  }
  function ensureFace() {
    if (!want3d()) return Promise.resolve(null);
    if (face) return Promise.resolve(face);
    if (facePromise) return facePromise;
    if (!webglOk()) {
      faceFailed = true;
      showPortrait('Still portrait: WebGL unavailable');
      showRetry(true);
      return Promise.resolve(null);
    }
    showRetry(false);
    set3dStatus('loading portrait');
    const amara = cast.find(c => c.id === 'amara');
    facePromise = import('./avatar/portrait.js').then(mod => mod.mount($('avatarMount'), {
      profile: amara,
      imageUrl: amara && amara.portrait,
      onReady: api => {
        face = api;
        faceFailed = false;
        revealStage();
      }
    })).then(api => {
      face = api;
      faceFailed = false;
      showStage();
      if (document.body.dataset.view !== 'home') api.setVisible(false);
      return api;
    }).catch(err => {
      console.error(errorText(err));
      faceFailed = true;
      facePromise = null;
      showPortrait(failText(err));
      showRetry(true);
      return null;
    });
    return facePromise;
  }
  function bootAvatar() {
    const box = $('avatar3d');
    const on = want3d();
    if (box) box.checked = on;
    if (!on) { showPortrait('Still portrait · no lip sync'); showRetry(false); return; }
    showRetry(false);
    set3dStatus('loading portrait');
    if (window.requestAnimationFrame) requestAnimationFrame(() => ensureFace());
    else setTimeout(() => ensureFace(), 0);
  }

  const synth = window.speechSynthesis; let voices = [], unlocked = false;
  const loadVoices = () => {
    if (!synth) return;
    const all = synth.getVoices().filter(v => /^en/i.test(v.lang));
    const seen = new Set();
    voices = all.sort((x, y) => (/US/i.test(y.lang) - /US/i.test(x.lang)) || (y.localService - x.localService))
      .filter(v => !seen.has(v.name) && seen.add(v.name));
  };
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; setTimeout(loadVoices, 500); setTimeout(loadVoices, 2000); }
  const castOrder = ['coach', 'jasmine', 'renee', 'marcus'];
  function profileFor(id) {
    return cast.find(c => c.speakerId === id || (id === 'coach' && c.id === 'amara')) || null;
  }
  function voiceCfg(id) {
    const base = (chars[id] || chars.coach).voice || {};
    const row = profileFor(id);
    return Object.assign({}, base, (row && row.voice) || {});
  }
  function voiceFor(id, cfg) {
    if (!voices.length) return null;
    const ranked = ['Google', 'Natural', 'Neural'].concat(cfg.prefer || []);
    const pref = ranked.map(s => voices.find(v => v.name && v.name.includes(s))).find(Boolean);
    if (pref) return pref;
    const i = Math.max(0, castOrder.indexOf(id));
    return voices[i % voices.length];
  }
  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    if (synth) {
      try { synth.cancel(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); synth.resume(); } catch (e) {}
    }
    if (face) { face.resume(); face.kick(); }
    const ctx = audioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  function speakChunk(text, voice, pitch, rate, onutter) {
    return new Promise(res => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
      u.pitch = pitch; u.rate = rate;
      let done = false;
      const fin = () => { if (!done) { done = true; clearTimeout(t); res(); } };
      const t = setTimeout(fin, 1500 + text.length * 90 / rate);
      u.onend = u.onerror = fin;
      if (onutter) onutter(u);
      synth.speak(u);
    });
  }
  function isAmara(speaker) { return speaker === 'coach' || speaker === 'amara'; }
  let audioCtx = null, currentSource = null, speechWait = null, toldTts = '';
  function audioContext() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    return audioCtx;
  }
  function stopPlayback() {
    if (currentSource) { try { currentSource.stop(); } catch (e) {} currentSource = null; }
    if (speechWait) { const done = speechWait; speechWait = null; done(); }
  }
  function waitMs(ms) {
    return new Promise(resolve => {
      const t = setTimeout(finish, ms);
      function finish() { clearTimeout(t); if (speechWait === finish) speechWait = null; resolve(); }
      speechWait = finish;
    });
  }
  function noteTts(kind) {
    if (toldTts === kind) return;
    toldTts = kind;
    if (kind === 'eleven-limit') $('note').textContent = "This month's ElevenLabs characters are used up. I'll use the next voice.";
    else if (kind === 'eleven-rate') $('note').textContent = "ElevenLabs is busy. I'll use the next voice.";
    else if (kind === 'limit') $('note').textContent = "That's today's Gemini voice allowance. I'll use this browser's voice until tomorrow.";
    else if (kind === 'rate') $('note').textContent = "Google's free voice tier is busy. I'll use this browser's voice for now.";
  }
  function playbackContext(line) {
    if (face && isAmara(line && line.speaker) && face.audioContext) {
      const ctx = face.audioContext();
      if (ctx) return ctx;
    }
    return audioContext();
  }
  function bytesToBuffer(ctx, bytes) {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return ctx.decodeAudioData(copy);
  }
  async function playBuffer(buffer, line, spoken, plan) {
    const ctx = playbackContext(line);
    if (ctx && ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    const timed = plan && plan.visemes && plan.visemes.length
      ? plan
      : BrimSpeech.fitWords(spoken, Math.round((buffer.duration || 0.3) * 1000));
    const moving = face && isAmara(line.speaker);
    if (moving) {
      face.speak({
        audio: buffer,
        audible: true,
        words: timed.words,
        wtimes: timed.wtimes,
        wdurations: timed.wdurations,
        visemes: timed.visemes,
        vtimes: timed.vtimes,
        vdurations: timed.vdurations
      }, { emotion: line.emotion || null });
      await waitMs(Math.ceil((buffer.duration || 0.3) * 1000) + 60);
      return;
    }
    if (!ctx) return;
    await new Promise(resolve => {
      const src = ctx.createBufferSource();
      currentSource = src;
      src.buffer = buffer;
      src.connect(ctx.destination);
      const finish = () => { if (currentSource === src) currentSource = null; resolve(); };
      src.onended = finish;
      speechWait = finish;
      try { src.start(); } catch (e) { finish(); }
    });
  }
  function elevenVoiceId(speakerId) {
    const row = profileFor(speakerId);
    const saved = readJSON(ELEVEN_VOICES, {});
    if (row && saved[row.id]) return saved[row.id];
    if (row && row.voice && row.voice.elevenVoice) return row.voice.elevenVoice;
    const picked = BrimSpeech.pickVoice([], row && row.id);
    return picked.voice_id;
  }
  async function prepareSpeech(text, line, cfg) {
    if (localStorage.getItem(ELEVEN_KEY)) {
      const first = await eleven.synthesize(text, elevenVoiceId(line.speaker));
      paintVoices();
      if (first && first.bytes) {
        const ctx = playbackContext(line);
        if (ctx) {
          try {
            const buffer = await bytesToBuffer(ctx, first.bytes);
            if (buffer) return { buffer, spoken: first.spoken, plan: first.plan };
          } catch (e) {}
        }
      } else if (first && (first.blocked === 'limit' || first.blocked === 'rate')) noteTts('eleven-' + first.blocked);
    }
    const voiceName = cfg.geminiVoice || 'Sulafat';
    const style = BrimSpeech.styleFor(cfg.style, line.emotion);
    const result = await speaker.synthesize(text, voiceName, style);
    paintGemini();
    if (!result || result.blocked || !result.bytes) {
      if (result && (result.blocked === 'limit' || result.blocked === 'rate')) noteTts(result.blocked);
      return null;
    }
    const ctx = playbackContext(line);
    if (!ctx) return null;
    try {
      const buffer = await bytesToBuffer(ctx, result.bytes);
      return { buffer, spoken: result.spoken };
    } catch (e) { return null; }
  }
  async function speak(line) {
    const gen = speechGen;
    const id = playId;
    const parts = BrimSpeech.sentences(line && line.text);
    if (!parts.length) return;
    const cfg = voiceCfg(line.speaker);
    let upcoming = prepareSpeech(parts[0], line, cfg);
    for (let i = 0; i < parts.length; i++) {
      if (speechGen !== gen || id !== playId) return;
      const ready = await upcoming;
      upcoming = i + 1 < parts.length ? prepareSpeech(parts[i + 1], line, cfg) : null;
      if (speechGen !== gen || id !== playId) return;
      if (ready && ready.buffer) {
        await playBuffer(ready.buffer, line, ready.spoken, ready.plan);
        continue;
      }
      await speakBrowser(parts[i], line, cfg, gen, id);
    }
  }
  async function speakBrowser(text, line, cfg, gen, id) {
    if (!synth || speechGen !== gen || id !== playId) return;
    const v = voiceFor(line.speaker, cfg);
    const engine = BrimSpeech.browserSpells(v) ? 'basic' : 'natural';
    const spoken = BrimSpeech.spokenText(text, engine);
    let pitch = cfg.pitch || 1, rate = (cfg.rate || 1) * (eng.p.driving ? 1.05 : 1);
    if (voices.length < 2 && line.speaker !== 'coach') pitch = Math.min(2, Math.max(0.1, 1 + (pitch - 1) * 1.8));
    const moving = face && isAmara(line.speaker);
    if (moving) face.speak(spoken, { rate, pitch, emotion: line.emotion || null });
    await speakChunk(spoken, v, pitch, rate, moving ? u => face.bindUtterance(u) : null);
  }
  let stopSpeaking = false, busy = false, playId = 0, greeted = false, listening = false, gotResult = false, misses = 0;
  function show(line) {
    const c = chars[line.speaker] || chars.coach;
    const d = el('div', 'l ' + (line.speaker === 'user' ? 'user' : line.speaker));
    const pic = portraitOf(line.speaker);
    if (pic && line.speaker !== 'user') {
      const img = el('img');
      img.src = pic;
      img.alt = '';
      d.append(img);
    } else d.append(el('div', 'av', (c.name || 'Y')[0]));
    const t = el('div', 't');
    t.append(el('small', null, c.name || 'You'));
    t.append(document.createTextNode(line.text));
    d.append(t);
    $('log').append(d);
    $('log').scrollTop = 1e9;
  }
  function setCaption(line) {
    const name = line.speaker === 'user' ? 'You' : (chars[line.speaker] || chars.coach).name;
    $('bubbleName').textContent = name;
    $('caption').textContent = line.text;
    $('liveName').textContent = name;
    $('liveLine').textContent = line.text;
  }
  function idleCaption() {
    $('bubbleName').textContent = 'Coach Amara';
    $('liveName').textContent = 'Coach Amara';
    const text = eng.p.name
      ? 'Hey ' + eng.p.name + '! Where would you like to go today?'
      : "I'm Amara, your coach. What should I call you?";
    $('caption').textContent = text;
    $('liveLine').textContent = text;
  }
  async function play(lines) {
    const id = ++playId;
    busy = true; stopSpeaking = false; stopListening();
    for (const l of lines || []) {
      show(l); setCaption(l);
      if (l.emotion && face) face.react(l.emotion);
      setAvatarState('speaking', { speaker: l.speaker });
      if (id !== playId) return;
      await speak(l);
      if (id !== playId) return;
    }
    if (id !== playId) return;
    setAvatarState('idle', { speaker: 'coach' });
    busy = false;
    save();
    if ($('auto').checked && rec && lines && lines.length && document.visibilityState === 'visible') setTimeout(listen, 250);
  }
  async function send(text) {
    const value = (text || '').trim();
    if (!value) return;
    unlockAudio();
    greeted = true;
    interrupt();
    show({ speaker: 'user', text: value });
    try {
      const emotion = (await import('./avatar/lipsync.js')).emotionFromText(value);
      if (emotion && face) face.react(emotion);
    } catch (e) {}
    setAvatarState('thinking', { speaker: 'coach' });
    const lines = await eng.handle(value);
    if ((eng.mode === 'area' || eng.mode === 'reflect') && eng.area) { setRoute('#/area/' + eng.area.id); showArea(eng.area); }
    else showHome();
    play(lines);
  }
  let speechGen = 0;
  function interrupt() {
    speechGen++;
    stopSpeaking = true;
    playId++;
    busy = false;
    stopPlayback();
    if (synth) synth.cancel();
    if (face) face.interrupt();
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  if (SR && window.isSecureContext) {
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
    rec.onresult = e => { gotResult = true; misses = 0; send(e.results[e.results.length - 1][0].transcript); };
    rec.onend = () => {
      listening = false; $('mic').classList.remove('on');
      if (document.body.dataset.voice === 'listening') setAvatarState('idle', { speaker: 'coach' });
      if (!gotResult && !busy && $('auto').checked && misses < 6 && document.visibilityState === 'visible') { misses++; setTimeout(listen, 300); }
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        misses = 99;
        $('note').textContent = 'Microphone blocked. Tap the lock icon in the address bar and allow the microphone.';
      }
    };
  } else $('note').textContent = !window.isSecureContext
    ? 'Microphone needs a secure (https) link. You can type for now.'
    : 'Speech recognition is not supported in this browser (use Chrome). You can type instead. The coach still talks.';
  function listen() {
    if (!rec || listening || busy) return;
    gotResult = false;
    try { rec.start(); listening = true; $('mic').classList.add('on'); setAvatarState('listening', { speaker: 'coach' }); } catch (e) {}
  }
  function stopListening() { if (rec && listening) { try { rec.abort(); } catch (e) {} listening = false; $('mic').classList.remove('on'); } }
  $('mic').onclick = () => {
    unlockAudio();
    if (!greeted) { greeted = true; play(eng.welcome()); return; }
    misses = 0;
    if (listening) { misses = 99; stopListening(); setAvatarState('idle', { speaker: 'coach' }); return; }
    interrupt();
    listen();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      stopListening();
      if (synth) synth.cancel();
      return;
    }
    if (face && want3d() && document.body.dataset.view === 'home') {
      face.setVisible(true);
      face.kick();
      refresh3dStatus();
    }
  });
  window.addEventListener('resize', () => { if (face) face.kick(); });

  $('typeBtn').onclick = () => { $('typeRow').hidden = !$('typeRow').hidden; if (!$('typeRow').hidden) $('txt').focus(); };
  $('typeRow').onsubmit = e => { e.preventDefault(); const v = $('txt').value; $('txt').value = ''; send(v); };
  $('viewBtn').onclick = () => { if (!$('convo').open) $('convo').showModal(); };
  $('convoClose').onclick = () => $('convo').close();
  $('changeSubject').onclick = () => { if (eng.mode !== 'menu' && eng.mode !== 'askname') send('change subject'); };

  let silentHash = 0;
  function setRoute(hash) {
    if ((location.hash || '#/') === hash) return;
    silentHash++;
    location.hash = hash;
  }
  function showHome(opts) {
    document.body.dataset.view = 'home';
    $('areaView').hidden = true;
    if (!opts || !opts.keepHash) setRoute('#/');
    document.querySelectorAll('[data-area]').forEach(btn => btn.classList.remove('on'));
    document.body.classList.remove('nav-open');
    $('tabHome').classList.add('on');
    if (face) face.setVisible(true);
  }
  function showArea(area) {
    document.body.dataset.view = 'area';
    $('areaView').hidden = false;
    if (face) face.setVisible(false);
    $('areaKicker').textContent = area.summary;
    $('areaTitle').textContent = area.title;
    $('areaLead').textContent = area.intro;
    $('areaPct').textContent = areaPercent(area) + '%';
    const acts = $('areaActivities');
    acts.replaceChildren();
    (area.activityIds || []).forEach(id => {
      const a = activityById(id);
      if (!a) return;
      const card = el('article', 'act-card');
      card.append(el('h3', null, a.title), el('p', null, BLURB[id] || a.world));
      if (content[id] && content[id].disclaimer) card.append(el('p', 'fine', content[id].disclaimer));
      const score = el('p', 'fine');
      score.dataset.score = id;
      card.append(score);
      const b = el('button', 'gold', 'Start');
      b.type = 'button';
      b.dataset.activity = id;
      b.onclick = () => launchActivity(a);
      card.append(b);
      acts.append(card);
    });
    const reflect = $('areaReflect');
    reflect.replaceChildren();
    if (area.reflections && area.reflections.length) {
      reflect.append(el('h3', null, 'Reflect with Amara'));
      const list = el('ol', 'prompts');
      area.reflections.forEach(r => list.append(el('li', null, r.prompt)));
      const b = el('button', 'gold', 'Begin reflection');
      b.type = 'button';
      b.onclick = () => launchReflection(area.id);
      const score = el('p', 'fine');
      score.id = 'reflectScore';
      reflect.append(list, b, score);
    }
    const coming = $('areaComing');
    coming.replaceChildren();
    (area.coming || []).forEach(label => {
      const li = el('li');
      li.append(document.createTextNode(label + ' '), el('em', null, 'More coming'));
      coming.append(li);
    });
    document.querySelectorAll('[data-area]').forEach(btn => btn.classList.toggle('on', btn.dataset.area === area.id));
    document.body.classList.remove('nav-open');
    paintScores();
  }
  function launchActivity(a) {
    unlockAudio();
    greeted = true;
    if (eng.p.driving && !a.driving) {
      showHome();
      play([eng.C("That one needs your full attention, so let's save it for when you're parked. Try communication or Security plus.")]);
      return;
    }
    show({ speaker: 'user', text: a.title });
    showHome();
    play(eng.start(a));
  }
  function launchArea(id) {
    const area = areas.find(a => a.id === id);
    if (!area) return;
    unlockAudio();
    greeted = true;
    setRoute('#/area/' + id);
    showArea(area);
    play(eng.openArea(area));
  }
  function launchReflection(id) {
    const area = areas.find(a => a.id === id);
    if (!area) return;
    unlockAudio();
    greeted = true;
    setRoute('#/area/' + id);
    const intro = (!eng.area || eng.area.id !== id || eng.mode !== 'area') ? eng.openArea(area) : [];
    showArea(area);
    play(intro.concat(eng.startReflection()));
  }
  function applyRoute() {
    const h = location.hash || '#/';
    if (h.startsWith('#/area/')) {
      const area = areas.find(a => a.id === decodeURIComponent(h.slice('#/area/'.length)));
      if (area) {
        if (!eng.area || eng.area.id !== area.id || (eng.mode !== 'area' && eng.mode !== 'reflect' && eng.mode !== 'scenario' && eng.mode !== 'drill' && eng.mode !== 'quiz')) eng.openArea(area);
        showArea(area);
        return;
      }
    }
    showHome({ keepHash: true });
  }
  window.addEventListener('hashchange', () => { if (silentHash) { silentHash--; return; } applyRoute(); });
  $('areaBack').onclick = () => showHome();

  function buildSidebar() {
    const nav = $('sideNav');
    areas.forEach(area => {
      const b = el('button', 'navitem');
      b.type = 'button';
      b.dataset.area = area.id;
      const text = el('span', 'txt');
      text.append(el('strong', null, area.title), el('small', null, area.summary));
      const pct = el('span', 'pct', '0%');
      pct.dataset.pct = area.id;
      b.append(icon(area.icon), text, pct);
      b.onclick = () => launchArea(area.id);
      nav.append(b);
    });
  }
  function buildTeam() {
    const row = $('teamRow');
    cast.forEach(c => {
      const b = el('button', 'team-card');
      b.type = 'button';
      b.dataset.avatar = '';
      b.dataset.speaker = c.speakerId === 'coach' ? 'amara' : c.speakerId;
      b.dataset.state = 'idle';
      const img = el('img');
      img.src = c.portrait;
      img.alt = 'Still portrait of ' + c.name;
      b.append(img, el('strong', null, c.name), el('small', null, c.role));
      b.onclick = () => {
        if (c.activityId) launchActivity(activityById(c.activityId));
        else { showHome(); unlockAudio(); greeted = true; play(eng.welcome()); }
      };
      row.append(b);
    });
  }
  function buildTimeline() {
    const track = $('track');
    const origin = el('button', 'node');
    origin.type = 'button';
    origin.innerHTML = '<span class="dot" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>';
    origin.append(el('strong', null, 'Choose a path'), el('small', null, 'Any order'));
    origin.onclick = () => showHome();
    track.append(origin);
    areas.forEach(area => {
      const b = el('button', 'node');
      b.type = 'button';
      const dot = el('span', 'dot');
      dot.append(icon(area.icon));
      const meter = el('div', 'meter');
      const fill = el('span');
      fill.dataset.bar = area.id;
      meter.append(fill);
      const pct = el('small', null, '0%');
      pct.dataset.pct = area.id;
      b.append(dot, el('strong', null, area.title.replace(' & ', ' & ')), pct, meter);
      b.onclick = () => launchArea(area.id);
      track.append(b);
    });
  }
  function buildSuggestions() {
    const weak = eng.weakest();
    const items = [
      { id: 'secplus-701', kicker: 'Career & Income', title: 'Security+ study session', meta: 'Four questions, said out loud' },
      { id: 'interruptions', kicker: 'Communication', title: 'Handling interruptions', meta: 'A short meeting drill' },
      { id: 'spice-aisle', kicker: 'Relationships', title: 'Spice aisle', meta: 'One social scene' },
      { area: 'mindset', kicker: 'Mindset', title: 'Mindset reset', meta: 'Three questions with Amara' }
    ];
    items.sort((a, b) => (a.id && weak && a.id === weak.id ? -1 : 0) - (b.id && weak && b.id === weak.id ? -1 : 0));
    const row = $('suggestRow');
    row.replaceChildren();
    items.forEach(item => {
      const b = el('button', 'suggest' + (weak && item.id === weak.id ? ' rec' : ''));
      b.type = 'button';
      if (item.id) b.dataset.activity = item.id;
      b.append(el('span', 'kicker', weak && item.id === weak.id ? 'Recommended' : item.kicker), el('strong', null, item.title), el('small', null, item.meta));
      b.onclick = () => item.area ? launchReflection(item.area) : launchActivity(activityById(item.id));
      row.append(b);
    });
  }
  function renderFocus() {
    const weak = eng.weakest();
    if (!weak) {
      $('focusTitle').textContent = 'Choose a path';
      $('focusSub').textContent = 'No scored practice yet';
      $('focusFill').style.width = '0%';
      $('focusPct').textContent = '0%';
      $('focusGo').dataset.activity = '';
      return;
    }
    const best = (eng.p.mastery[content[weak.id].skill] || {}).best || 0;
    $('focusTitle').textContent = weak.title;
    $('focusSub').textContent = weak.world;
    $('focusFill').style.width = best + '%';
    $('focusPct').textContent = best + '%';
    $('focusGo').dataset.activity = weak.id;
  }
  function renderChallenge() {
    const weak = eng.weakest();
    const act = weak || activityById('secplus-701');
    $('challengeTitle').textContent = act.title;
    $('challengeText').textContent = act.id === 'secplus-701' && !weak
      ? 'Teach a Security+ concept out loud to Coach Amara.'
      : 'This is the practice with the most room to grow. Say it out loud with Amara.';
    $('challengeGo').dataset.activity = act.id;
  }
  function paintScores() {
    document.querySelectorAll('[data-score]').forEach(node => {
      const skill = content[node.dataset.score] && content[node.dataset.score].skill;
      const m = skill && eng.p.mastery[skill];
      node.textContent = m && m.attempts ? 'Best ' + m.best : 'Not started';
    });
    const rs = $('reflectScore');
    if (rs && eng.area && eng.area.skill) {
      const m = eng.p.mastery[eng.area.skill];
      rs.textContent = m && m.attempts ? 'Reflection best ' + m.best : '';
    }
  }
  function renderStats() {
    const p = eng.p;
    const span = levelSpan(p.xp);
    $('userName').textContent = p.name || 'You';
    $('userInitial').textContent = (p.name || 'Y').slice(0, 1).toUpperCase();
    $('userLevel').textContent = 'Level ' + span.lv + ' · ' + p.xp.toLocaleString() + ' XP';
    $('xpFill').style.width = Math.round(span.t * 100) + '%';
    $('streakText').textContent = p.streak + ' Day Streak';
    $('journeyPct').textContent = overallPercent() + '%';
    $('drive').checked = !!p.driving;
    $('driveNote').hidden = !p.driving;
    areas.forEach(area => {
      const n = areaPercent(area);
      document.querySelectorAll('[data-pct="' + area.id + '"]').forEach(node => { node.textContent = n + '%'; });
      document.querySelectorAll('[data-bar="' + area.id + '"]').forEach(node => { node.style.width = n + '%'; });
    });
    if (document.body.dataset.view === 'area' && eng.area) $('areaPct').textContent = areaPercent(eng.area) + '%';
    renderFocus();
    renderChallenge();
    buildSuggestions();
    paintScores();
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(eng.p)); renderStats(); }
  function paintGemini() {
    const modelBox = $('geminiModel');
    const savedModel = localStorage.getItem(GEMINI_MODEL) || GEMINI_DEFAULT;
    if (modelBox && document.activeElement !== modelBox) modelBox.value = savedModel;
    const usage = llm.usageNow();
    if ($('geminiUsage')) $('geminiUsage').textContent = usage.count + ' of ' + (llm.dailyLimit || 50) + ' AI turns today.';
    if ($('ttsUsage') && speaker) {
      const voiceUse = speaker.usageNow();
      $('ttsUsage').textContent = voiceUse.count + ' of ' + speaker.dailyLimit + ' spoken lines today.';
    }
    if ($('geminiStatus')) $('geminiStatus').textContent = localStorage.getItem(GEMINI_KEY) ? 'A key is saved on this device.' : 'No key saved.';
  }
  function paintVoices() {
    const usage = readJSON(ELEVEN_USAGE, null);
    if ($('elevenStatus')) $('elevenStatus').textContent = localStorage.getItem(ELEVEN_KEY) ? 'An ElevenLabs key is saved on this device.' : 'No ElevenLabs key saved.';
    if ($('elevenUsage')) {
      $('elevenUsage').textContent = usage && usage.character_limit
        ? usage.character_count.toLocaleString() + ' of ' + usage.character_limit.toLocaleString() + ' characters this month' + (usage.tier ? ' (' + usage.tier + ').' : '.')
        : 'Monthly characters appear after a key is saved.';
    }
    refresh3dStatus();
  }
  function voiceChoices(list) {
    const saved = readJSON(ELEVEN_VOICES, {});
    return cast.map(row => {
      const chosen = saved[row.id] || (row.voice && row.voice.elevenVoice);
      const voices = (list || []).slice();
      if (chosen && !voices.some(v => v.voice_id === chosen)) {
        const preset = BrimSpeech.pickVoice([], row.id);
        voices.unshift({ voice_id: chosen, name: (preset.voice_id === chosen ? preset.name : chosen), labels: {} });
      }
      return { row, voices: voices.length ? voices : [BrimSpeech.pickVoice([], row.id)], chosen };
    });
  }
  function buildVoicePickers(list) {
    const box = $('voicePickers');
    if (!box) return;
    box.replaceChildren();
    voiceChoices(list).forEach(({ row, voices, chosen }) => {
      const label = el('label', 'field', row.name.replace(/^Coach /, ''));
      label.htmlFor = 'voice-' + row.id;
      const sel = document.createElement('select');
      sel.id = 'voice-' + row.id;
      voices.forEach(v => {
        const o = document.createElement('option');
        o.value = v.voice_id;
        const gender = v.labels && v.labels.gender ? ' · ' + v.labels.gender : '';
        o.textContent = v.name + gender;
        if (v.voice_id === chosen) o.selected = true;
        sel.append(o);
      });
      sel.onchange = () => {
        const next = readJSON(ELEVEN_VOICES, {});
        next[row.id] = sel.value;
        localStorage.setItem(ELEVEN_VOICES, JSON.stringify(next));
      };
      box.append(label, sel);
    });
  }
  async function loadElevenVoices() {
    if (!localStorage.getItem(ELEVEN_KEY)) { buildVoicePickers([]); return; }
    const listed = await eleven.listVoices();
    buildVoicePickers(listed && listed.voices);
    if (listed && listed.blocked === 'error') $('elevenStatus').textContent = 'Could not load voices from ElevenLabs.';
  }

  function badges() {
    const p = eng.p;
    const out = [];
    if (p.name) out.push(['Introduced', 'Amara knows your name']);
    if (p.xp > 0) out.push(['First light', 'You earned XP']);
    if (BrimEngine.level(p.xp) >= 2) out.push(['Rising', 'Reached level ' + BrimEngine.level(p.xp)]);
    if (p.streak >= 2) out.push(['Returned', p.streak + '-day streak']);
    Object.entries(p.mastery).forEach(([k, v]) => { if (v && v.best >= 85) out.push(['Mastered', k + ' best ' + v.best]); });
    return out;
  }
  function openHistory() {
    const p = eng.p;
    const body = $('dlgbody');
    body.replaceChildren();
    body.append(el('p', null, eng.progressSummary()));
    const marks = el('div', 'badges');
    const list = badges();
    if (!list.length) marks.append(el('span', 'badge', 'No marks yet'));
    list.forEach(([title, detail]) => marks.append(el('span', 'badge', title + ' · ' + detail)));
    body.append(marks);
    const ol = el('ol');
    p.history.forEach(h => {
      const li = el('li');
      li.append(el('b', null, new Date(h.t).toLocaleString() + ': ' + h.activity + ' (score ' + h.score + ', +' + h.xp + ' XP)'));
      li.append(el('div', 'fine', h.summary));
      ol.append(li);
    });
    if (!p.history.length) body.append(el('p', 'fine', 'No sessions yet.'));
    body.append(ol);
    if (!$('dlg').open) $('dlg').showModal();
  }
  $('journeyCard').onclick = openHistory;
  $('openHist').onclick = openHistory;
  $('hist') && ($('hist').onclick = openHistory);
  $('close').onclick = () => $('dlg').close();
  $('clear').onclick = () => {
    if (!confirm('Delete all saved progress and history on this device?')) return;
    localStorage.removeItem(KEY);
    localStorage.removeItem(GEMINI_TURNS);
    eng.p = BrimEngine.newProfile();
    eng.mode = 'askname';
    eng.area = null;
    eng.act = null;
    greeted = false;
    $('log').replaceChildren();
    idleCaption();
    save();
    $('dlg').close();
    showHome();
  };
  $('settingsBtn').onclick = () => { paintGemini(); paintVoices(); loadElevenVoices(); $('settingsDlg').showModal(); };
  $('settingsClose').onclick = () => $('settingsDlg').close();
  $('geminiSave').onclick = () => {
    const typed = ($('geminiKey').value || '').trim();
    const model = ($('geminiModel').value || '').trim() || GEMINI_DEFAULT;
    localStorage.setItem(GEMINI_MODEL, model);
    if (typed) {
      localStorage.setItem(GEMINI_KEY, typed);
      $('geminiKey').value = '';
    }
    if (localStorage.getItem(GEMINI_KEY)) {
      llm.enabled = true;
      eng.provider = llm;
    }
    paintGemini();
    if (!localStorage.getItem(GEMINI_KEY)) $('geminiStatus').textContent = 'Add a key first.';
  };
  $('elevenSave').onclick = () => {
    const typed = ($('elevenKey').value || '').trim();
    if (typed) {
      localStorage.setItem(ELEVEN_KEY, typed);
      $('elevenKey').value = '';
    }
    paintVoices();
    if (!localStorage.getItem(ELEVEN_KEY)) $('elevenStatus').textContent = 'Add a key first.';
    else loadElevenVoices();
  };
  $('elevenRemove').onclick = () => {
    localStorage.removeItem(ELEVEN_KEY);
    $('elevenKey').value = '';
    paintVoices();
    buildVoicePickers([]);
  };
  $('elevenTest').onclick = async () => {
    const typed = ($('elevenKey').value || '').trim();
    if (typed) localStorage.setItem(ELEVEN_KEY, typed);
    $('elevenKey').value = '';
    if (!localStorage.getItem(ELEVEN_KEY)) { $('elevenStatus').textContent = 'Add a key first.'; return; }
    $('elevenStatus').textContent = 'Testing…';
    const sub = await eleven.subscription();
    if (sub && !sub.blocked) {
      localStorage.setItem(ELEVEN_USAGE, JSON.stringify({ tier: sub.tier, character_count: sub.character_count, character_limit: sub.character_limit }));
      $('elevenStatus').textContent = 'Connected. ' + (sub.tier || 'plan') + ' plan.';
      paintVoices();
      loadElevenVoices();
      return;
    }
    if (sub && sub.blocked === 'badkey') $('elevenStatus').textContent = 'ElevenLabs rejected that key.';
    else if (sub && sub.blocked === 'rate') $('elevenStatus').textContent = 'ElevenLabs is busy. Try again in a moment.';
    else if (sub && sub.blocked === 'offline') $('elevenStatus').textContent = 'Offline. The key stayed on this device.';
    else $('elevenStatus').textContent = 'Could not reach ElevenLabs.';
  };
  $('geminiRemove').onclick = () => {
    localStorage.removeItem(GEMINI_KEY);
    $('geminiKey').value = '';
    llm.enabled = false;
    eng.provider = BrimEngine.ScriptedProvider;
    paintGemini();
  };
  $('geminiTest').onclick = async () => {
    const typed = ($('geminiKey').value || '').trim();
    $('geminiStatus').textContent = 'Testing…';
    const msg = await llm.testConnection(typed);
    $('geminiStatus').textContent = msg;
    if ($('geminiUsage')) $('geminiUsage').textContent = llm.usageNow().count + ' of ' + (llm.dailyLimit || 50) + ' AI turns today.';
  };
  paintGemini();
  paintVoices();
  buildVoicePickers([]);
  $('drive').onchange = e => send(e.target.checked ? 'driving mode on' : 'driving mode off');
  const tiltBox = $('tilt');
  if (tiltBox) {
    tiltBox.checked = localStorage.getItem('brimmesa.tilt') === 'on';
    tiltBox.onchange = e => {
      localStorage.setItem('brimmesa.tilt', e.target.checked ? 'on' : 'off');
      if (face && face.setTilt) face.setTilt(e.target.checked);
    };
  }
  $('avatar3d').onchange = e => {
    localStorage.setItem('brimmesa.avatar', e.target.checked ? '3d' : 'portrait');
    if (e.target.checked) {
      faceFailed = false;
      if (face) {
        showStage();
        if (document.body.dataset.view === 'home') face.setVisible(true);
        return;
      }
      facePromise = null;
      ensureFace().then(api => { if (api && document.body.dataset.view === 'home') api.setVisible(true); });
    } else if (face) {
      face.setVisible(false);
      showPortrait('Still portrait · no lip sync');
      showRetry(false);
    } else {
      showPortrait('Still portrait · no lip sync');
      showRetry(false);
    }
  };
  if ($('retry3d')) $('retry3d').onclick = () => {
    localStorage.setItem('brimmesa.avatar', '3d');
    if ($('avatar3d')) $('avatar3d').checked = true;
    faceFailed = false;
    facePromise = null;
    if (face) { try { face.dispose(); } catch (err) {} face = null; }
    const node = $('avatarMount');
    if (node) node.replaceChildren();
    $('heroFrame').classList.remove('is-3d');
    showRetry(false);
    set3dStatus('loading portrait');
    ensureFace().then(api => { if (api && document.body.dataset.view === 'home') api.setVisible(true); });
  };
  bootAvatar();
  const voiceBox = $('voicePreviews');
  if (voiceBox) cast.forEach(row => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = 'Preview ' + row.name.replace(/^Coach /, '');
    b.onclick = () => {
      unlockAudio();
      interrupt();
      const text = row.id === 'amara' ? 'Hi. I am Coach Amara, from BRIMMESA.' : 'Hi. I am ' + row.name + '.';
      speak({ speaker: row.speakerId || 'coach', text, emotion: 'smile' });
    };
    voiceBox.append(b);
  });
  $('focusEdit').onclick = () => document.body.classList.add('nav-open');
  $('focusGo').onclick = () => {
    const id = $('focusGo').dataset.activity;
    if (id) launchActivity(activityById(id));
    else document.body.classList.add('nav-open');
  };
  $('challengeGo').onclick = () => { const id = $('challengeGo').dataset.activity; if (id) launchActivity(activityById(id)); };
  $('menuBtn').onclick = () => document.body.classList.toggle('nav-open');
  $('scrim').onclick = () => document.body.classList.remove('nav-open');
  $('tabHome').onclick = () => showHome();
  $('tabMap').onclick = () => document.body.classList.add('nav-open');
  $('tabTeam').onclick = () => { showHome(); $('team').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  $('tabJourney').onclick = openHistory;

  buildSidebar();
  buildTeam();
  buildTimeline();
  idleCaption();
  renderStats();
  applyRoute();
})().catch(err => {
  const note = document.getElementById('note');
  if (note) note.textContent = 'The coach could not load. Reload the page.';
  console.error(err);
});
