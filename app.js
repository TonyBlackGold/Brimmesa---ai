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
  const latencyMarks = [];
  function markLatency(stage, note) {
    latencyMarks.push({ stage: stage, t: Date.now(), note: note || '' });
    if (latencyMarks.length > 120) latencyMarks.shift();
  }
  window.BrimLatency = { mark: markLatency, marks: latencyMarks };
  function applyHandsFreeDefault() {
    const box = $('auto');
    if (!box) return;
    const saved = localStorage.getItem('brimmesa.handsfree');
    const mobile = window.BrimVad ? !BrimVad.allowEnergyStream(navigator.userAgent || '', true) : /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
    if (saved === '1' || saved === '0') box.checked = saved === '1';
    else box.checked = !mobile;
    box.addEventListener('change', () => {
      localStorage.setItem('brimmesa.handsfree', box.checked ? '1' : '0');
      if (!box.checked) releaseVad();
    });
  }
  applyHandsFreeDefault();
  const worlds = await (await fetch('data/worlds.json')).json();
  const areasDoc = await (await fetch('data/areas.json')).json();
  const castDoc = await (await fetch('data/characters.json')).json();
  const destDoc = await (await fetch('data/destinations.json')).json();
  const destinations = destDoc.destinations || [];
  const areas = areasDoc.areas;
  const cast = castDoc.characters;
  const content = {};
  for (const w of worlds.worlds) for (const a of w.activities) content[a.id] = await (await fetch(a.file)).json();

  const chars = { coach: { name: worlds.coach.name, voice: worlds.coach.voice, color: '#e0b65a' }, user: { name: 'You', color: '#c9a24a' } };
  const palette = ['#e0b65a', '#d7a15a', '#c4b49a', '#8d6428'];
  Object.values(content).forEach(c => (c.characters || []).forEach((ch, i) => chars[ch.id] = { ...ch, color: palette[(ch.voice.index || i) % palette.length] }));
  const portraitOf = speaker => {
    const row = cast.find(c => c.id === speaker || c.speakerId === speaker || (speaker === 'coach' && c.id === 'amara'));
    return row && row.portrait;
  };
  cast.forEach(c => {
    chars[c.id] = Object.assign({}, chars[c.id] || {}, c, { color: (chars[c.id] && chars[c.id].color) || '#e0b65a' });
    if (c.speakerId) chars[c.speakerId] = Object.assign({}, chars[c.speakerId] || {}, c, { color: (chars[c.speakerId] && chars[c.speakerId].color) || '#e0b65a' });
    document.querySelectorAll('[data-portrait="' + c.id + '"]').forEach(img => { img.src = c.portrait; });
  });

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
  const rawGenerate = llm.generate.bind(llm);
  llm.generate = async function (prompt, schema) {
    const t0 = Date.now();
    markLatency('llm-start', 'generateContent is not streamed');
    try {
      const out = await rawGenerate(prompt, schema);
      markLatency('llm-complete', 'ok in ' + (Date.now() - t0) + 'ms');
      return out;
    } catch (e) {
      const reason = (e && e.reason) || (e && e.name === 'AbortError' ? 'timeout' : 'error');
      markLatency(reason === 'timeout' ? 'llm-timeout' : 'llm-complete', reason + ' after ' + (Date.now() - t0) + 'ms');
      if (reason === 'timeout') setStatus('thinking', 'Reply service slow, using the practice script');
      throw e;
    }
  };
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
    'secplus-701': 'Original Security+ practice. Not an official exam.',
    'current-affairs': 'A fetched story, or a skill drill if the feed is quiet.'
  };
  const ICONS = {
    mindset: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M8 13c1-2 2-3 4-3s3 1 4 3"/><path d="M9 10h.01M15 10h.01"/></svg>',
    health: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M6 9h3l1-3 2 8 2-5h4"/></svg>',
    career: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5h8v2"/></svg>',
    business: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M4 16l5-5 3 3 7-7"/><path d="M14 7h6v6"/></svg>',
    relationships: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><circle cx="8" cy="9" r="2.2"/><circle cx="16" cy="9" r="2.2"/><path d="M4 18c.6-2.4 2.4-3.5 4-3.5S11.4 15.6 12 18c.6-2.4 2.4-3.5 4-3.5s3.4 1.1 4 3.5"/></svg>',
    estate: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M4 20V10l8-6 8 6v10"/><path d="M10 20v-6h4v6"/></svg>',
    lifestyle: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M3 16l9-6 9 4-4 2"/><path d="M12 10V4"/><path d="M8 20h8"/></svg>',
    spirit: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>',
    affairs: '<svg viewBox="0 0 24 24" fill="none" stroke="#e0b65a" stroke-width="1.6"><path d="M5 5h10a4 4 0 0 1 4 4v10H9a4 4 0 0 1-4-4V5z"/><path d="M8 9h6M8 13h4"/></svg>'
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
    syncPresenter(known ? state : 'idle', speaker);
    const amara = speaker === 'coach' || speaker === 'amara';
    if (face) {
      face.setState(amara || state === 'idle' ? (known ? state : 'idle') : 'idle');
      if (amara && viseme) face.viseme(viseme);
    }
    const talk = $('talkFace');
    if (talk && !talk.hidden && talk.dataset.mouth === 'pulse') {
      const who = talk.dataset.coach;
      const mine = who === speaker || (who === 'amara' && amara) || (who === 'aria' && speaker === 'aria');
      const amt = mine && state === 'speaking' && window.BrimWorld ? BrimWorld.jawAmount(viseme) : 0;
      if (mine && state === 'speaking' && !viseme) talk.dataset.speaking = '1';
      else if (!mine || state !== 'speaking') { talk.dataset.speaking = '0'; talk.style.setProperty('--jaw', '0'); }
      else talk.style.setProperty('--jaw', String(amt));
    }
  }
  window.setAvatarState = setAvatarState;

  function presenterCoach(speaker, view) {
    if (speaker === 'amara') return 'amara';
    if (speaker === 'coach' && view === 'area') return 'amara';
    if (speaker === 'marcus' || speaker === 'jasmine' || speaker === 'renee') return speaker;
    return null;
  }
  function stageCoach() {
    if (hostSession && hostSession.coachId) return hostSession.coachId;
    const view = document.body.dataset.view;
    if (view === 'area' && (eng.mode === 'reflect' || eng.mode === 'area' || eng.act)) return 'amara';
    return null;
  }
  function syncPresenter(state, speaker) {
    const P = window.BrimPresenter;
    if (!P) return;
    const view = document.body.dataset.view || '';
    const speakingId = state === 'speaking' ? presenterCoach(speaker, view) : null;
    const stageId = stageCoach();
    if (speakingId && P.known(speakingId)) {
      P.show(speakingId);
      P.setState('speaking');
      return;
    }
    if (stageId && P.known(stageId) && P.current() === stageId) {
      P.setState(state && state !== 'speaking' ? state : 'idle');
      return;
    }
    if (!stageId || !P.known(stageId)) P.hide();
  }

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
  function preview3d() {
    try { return new URLSearchParams(location.search).get('preview3d') === '1'; }
    catch (e) { return false; }
  }
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
    return (preview3d() ? 'preview head did not start: ' : 'portrait did not start: ') + clean;
  }
  function set3dStatus(text) {
    const node = $('avatarStatus');
    if (node) node.textContent = (preview3d() ? 'Preview head: ' : 'Portrait status: ') + text;
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
  function ensureFace(mount) {
    const node = mount || $('talkMount') || $('avatarMount');
    if (!want3d() && !preview3d()) return Promise.resolve(null);
    if (face) {
      if (node && face.canvas && face.canvas.parentNode !== node) {
        node.replaceChildren(face.canvas);
        face.node = node;
      }
      try { face.setVisible(true); face.kick(); } catch (e) {}
      return Promise.resolve(face);
    }
    if (facePromise) return facePromise;
    if (!webglOk()) {
      faceFailed = true;
      showPortrait('Still portrait: WebGL unavailable');
      showRetry(true);
      return Promise.resolve(null);
    }
    showRetry(false);
    set3dStatus(preview3d() ? 'loading preview head' : 'loading portrait');
    const amara = cast.find(c => c.id === 'amara');
    const loader = preview3d() ? './avatar/preview3d.js' : './avatar/portrait.js';
    facePromise = import(loader).then(mod => mod.mount(node, {
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
      if (node && node.id !== 'talkMount' && document.body.dataset.view !== 'home') api.setVisible(false);
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
    if (!on && !preview3d()) { showPortrait('Still portrait · no lip sync'); showRetry(false); return; }
    showRetry(false);
    set3dStatus(preview3d() ? 'loading preview head' : 'loading portrait');
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
    return cast.find(c => c.id === id || c.speakerId === id || (id === 'coach' && c.id === 'amara')) || null;
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
  let browserToken = 0;
  function voiceSlow(reason) {
    markLatency('tts-timeout', reason || 'voice deadline');
    setStatus('speaking', 'Voice service slow, using backup voice');
    if ($('note')) $('note').textContent = 'Voice service slow, using backup voice.';
  }
  function speakChunk(text, voice, pitch, rate, onutter) {
    const token = ++browserToken;
    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
    u.pitch = pitch; u.rate = rate;
    if (onutter) onutter(u);
    markLatency('tts-browser', 'speak called');
    return BrimSpeech.speakBrowserDeadline(synth, u, {
      isCurrent: () => token === browserToken,
      onstart: () => markLatency('tts-start', 'browser speech started')
    }).then(result => {
      if (result && result.reason === 'timeout' && token === browserToken) voiceSlow('browser speech did not start in 2s');
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
  let pulseTimer = 0;
  function stopPulse() {
    if (pulseTimer) cancelAnimationFrame(pulseTimer);
    pulseTimer = 0;
    const box = $('talkFace');
    if (!box) return;
    box.style.setProperty('--jaw', '0');
    if (box.dataset.mouth === 'pulse') box.dataset.speaking = '0';
  }
  function roughPulse(text, rate) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const scale = 1 / Math.max(0.6, Math.min(1.6, rate || 1));
    let t = 40;
    const marks = [];
    words.forEach(word => {
      const dur = Math.round(Math.max(140, 64 * word.length) * scale);
      marks.push({ t: t, dur: dur, amt: /[aeiou]/i.test(word) ? 0.85 : 0.32 });
      t += dur + Math.round(30 * scale);
    });
    return { marks: marks, total: t + 120 };
  }
  function drivePulse(spec) {
    stopPulse();
    const box = $('talkFace');
    if (!box || box.hidden || box.dataset.mouth === 'warp' || !spec) return;
    const t0 = performance.now();
    const step = function (now) {
      const elapsed = now - t0;
      let amt = 0;
      if (spec.vtimes && window.BrimWorld) {
        for (let i = 0; i < spec.vtimes.length; i++) {
          if (elapsed >= spec.vtimes[i] && elapsed < spec.vtimes[i] + (spec.vdurations[i] || 80)) amt = BrimWorld.jawAmount(spec.visemes[i]);
        }
      } else if (spec.marks) {
        spec.marks.forEach(mark => { if (elapsed >= mark.t && elapsed < mark.t + mark.dur) amt = mark.amt; });
      }
      box.style.setProperty('--jaw', String(amt));
      box.dataset.speaking = '1';
      if (elapsed < (spec.total || 1600)) pulseTimer = requestAnimationFrame(step);
      else stopPulse();
    };
    pulseTimer = requestAnimationFrame(step);
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
    markLatency('tts-start', 'buffered speech');
    ttsOnset = performance.now();
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
    drivePulse(timed.vtimes ? timed : roughPulse(spoken, 1));
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
    const budget = BrimSpeech.CLOUD_TTS_TIMEOUT_MS;
    const started = Date.now();
    const left = () => budget - (Date.now() - started);
    if (localStorage.getItem(ELEVEN_KEY) && left() > 250) {
      markLatency('tts-eleven', 'request');
      const first = await eleven.synthesize(text, elevenVoiceId(line.speaker), { timeoutMs: left() });
      paintVoices();
      if (first && first.bytes) {
        const ctx = playbackContext(line);
        if (ctx) {
          try {
            const buffer = await bytesToBuffer(ctx, first.bytes);
            if (buffer) return { buffer, spoken: first.spoken, plan: first.plan };
          } catch (e) {}
        }
      } else if (first && first.blocked === 'timeout') voiceSlow(first.reason || 'elevenlabs slow');
      else if (first && (first.blocked === 'limit' || first.blocked === 'rate')) noteTts('eleven-' + first.blocked);
    }
    if (localStorage.getItem(GEMINI_KEY) && left() > 250) {
      const voiceName = cfg.geminiVoice || 'Sulafat';
      const style = BrimSpeech.styleFor(cfg.style, line.emotion);
      markLatency('tts-gemini', 'request');
      const result = await speaker.synthesize(text, voiceName, style, { timeoutMs: left() });
      paintGemini();
      if (result && result.bytes) {
        const ctx = playbackContext(line);
        if (!ctx) return null;
        try {
          const buffer = await bytesToBuffer(ctx, result.bytes);
          return { buffer, spoken: result.spoken };
        } catch (e) { return null; }
      }
      if (result && result.blocked === 'timeout') voiceSlow(result.reason || 'gemini tts slow');
      else if (result && (result.blocked === 'limit' || result.blocked === 'rate')) noteTts(result.blocked);
      return null;
    }
    return null;
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
    markLatency('tts-start', 'browser speech');
    ttsOnset = performance.now();
    const moving = face && isAmara(line.speaker);
    if (moving) face.speak(spoken, { rate, pitch, emotion: line.emotion || null });
    else drivePulse(roughPulse(spoken, rate));
    await speakChunk(spoken, v, pitch, rate, moving ? u => face.bindUtterance(u) : null);
    stopPulse();
  }
  let stopSpeaking = false, busy = false, playId = 0, greeted = false, listening = false, gotResult = false, misses = 0;
  let vadStream = null, vadCtx = null, vadAnalyser = null, vadTimer = 0, ttsOnset = 0, recStartedAt = 0;
  let vadState = { hotSince: 0, speaking: false, coolSince: 0 };
  let recIntentional = false, lastRecError = '', lastCoachLine = '', pendingHeard = null;
  let recRestarts = [];
  let vadBlocked = false, armListen = false, track = null, spokeUntil = 0, audioFails = 0;
  let interimTimer = 0;
  function acceptHeard(said, how) {
    const text = String(said || '').trim();
    if (!text || gotResult) return;
    clearTimeout(interimTimer);
    const Vad = window.BrimVad;
    const echoWindow = busy || (spokeUntil && Date.now() - spokeUntil < 1200);
    if (echoWindow && Vad && Vad.isEcho(text, lastCoachLine)) {
      setStatus('error', 'That matched Aria. Say your own line.');
      return;
    }
    gotResult = true;
    misses = 0;
    audioFails = 0;
    pendingHeard = { start: recStartedAt || (Date.now() - 800), end: Date.now() };
    markLatency('stt-end', how || 'recognition final');
    setStatus('heard', text);
    send(text);
  }
  function handsFreeOn() { return !!($('auto') && $('auto').checked); }
  function useEnergyVad() {
    return !vadBlocked && window.BrimVad && BrimVad.allowEnergyStream(navigator.userAgent || '', handsFreeOn());
  }
  function setStatus(state, detail) {
    const el = $('voiceStatus');
    if (!el) return;
    const label = { listening: 'Listening', heard: 'Heard', thinking: 'Thinking', speaking: 'Speaking', error: 'Error', ready: 'Ready' }[state] || 'Ready';
    const extra = detail ? ': ' + String(detail).replace(/\s+/g, ' ').trim().slice(0, 90) : '';
    el.dataset.state = state || 'ready';
    el.textContent = label + extra;
    el.title = label + extra;
  }
  function leavesTrack(value) {
    const t = String(value || '').trim();
    if (wantsAria(t)) return true;
    return /^(stop|quit|exit|menu|main menu|change subject|something else|i'm driving|im driving|driving mode on|driving mode off)$/i.test(t);
  }
  function offerTracks(lines) {
    return (lines || []).map(l => {
      if (!l || !/name a practice\./.test(l.text || '') || /vocabulary/.test(l.text || '')) return l;
      return Object.assign({}, l, { text: String(l.text).replace('name a practice.', 'name a practice. Say vocabulary or public speaking.') });
    });
  }
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
    pushComic(line);
    rememberSpoken(line);
  }
  function pushComic(line) {
    const box = $('comic');
    if (!box) return;
    const who = (chars[line.speaker] && chars[line.speaker].name) || line.speaker;
    const feedback = /Coach feedback|Scores:/.test(line.text || '');
    const panel = el('article', 'panel ' + (line.speaker === 'user' ? 'user' : line.speaker) + (feedback ? ' feedback' : ''));
    panel.append(el('p', 'who', who), el('p', null, line.text));
    box.append(panel);
    while (box.children.length > 6) box.firstChild.remove();
  }
  function setCaption(line) {
    const name = line.speaker === 'user' ? 'You' : (chars[line.speaker] || chars.coach).name;
    $('bubbleName').textContent = name;
    $('caption').textContent = line.text;
    $('liveName').textContent = name;
    $('liveLine').textContent = line.text;
    const src = portraitOf(line.speaker);
    if (src && line.speaker !== 'user') {
      const hero = $('heroImg');
      if (hero) { hero.src = src; hero.alt = 'Portrait of ' + name; }
      const strip = document.querySelector('.live-strip img');
      if (strip) { strip.src = src; strip.alt = 'Portrait of ' + name; }
      const frame = $('heroFrame');
      if (frame) frame.dataset.speaker = line.speaker === 'coach' ? 'amara' : line.speaker;
      const live = document.querySelector('.live-strip');
      if (live) live.dataset.speaker = line.speaker === 'coach' ? 'amara' : line.speaker;
    }
    if ($('ariaLine') && line.speaker === 'aria') $('ariaLine').textContent = line.text;
    const talk = $('talkFace');
    if (talk && !talk.hidden && $('talkLine')) {
      const who = talk.dataset.coach;
      const sp = line.speaker === 'coach' ? 'amara' : line.speaker;
      if (sp === who || line.speaker === 'aria') $('talkLine').textContent = line.text;
    }
    if (hostSession && line.speaker !== 'user' && line.speaker !== 'aria' && $('visitLine')) $('visitLine').textContent = line.text;
  }
  function present(line) {
    if (!line || line.speaker !== 'coach') return line;
    const id = (hostSession && hostSession.coachId) || eng.activeCoach || (document.body.dataset.view === 'area' ? 'amara' : 'aria');
    if (!id || id === 'coach') return line;
    return Object.assign({}, line, { speaker: id });
  }
  let opener = '', openerHeard = false, loopRun = null, hostSession = null, hostLock = false;
  const spokenRecent = [];
  if (window.BrimGym) (BrimGym.loadProfile().recent || []).forEach(t => spokenRecent.push({ speaker: t.speaker, text: t.text }));
  function rememberSpoken(line) {
    spokenRecent.push({ speaker: line.speaker, text: String(line.text || '').slice(0, 160) });
    if (spokenRecent.length > 8) spokenRecent.shift();
    try {
      if (!window.BrimGym) return;
      const last = spokenRecent[spokenRecent.length - 1];
      BrimGym.saveProfile(BrimGym.noteTurn(BrimGym.loadProfile(), last));
    } catch (e) {}
  }
  function coachMode(id) {
    if (!window.BrimGym || !id) return 'conversation';
    return BrimGym.coachOf(BrimGym.loadBoard(), id).mode;
  }
  function touchCoach(id, patch) {
    if (!window.BrimGym || !id) return;
    const board = BrimGym.loadBoard();
    const row = Object.assign(BrimGym.coachOf(board, id), patch || {});
    BrimGym.saveBoard(BrimGym.putCoach(board, id, row));
  }
  function idleCaption() {
    if (opener) {
      $('bubbleName').textContent = 'Aria';
      $('liveName').textContent = 'Aria';
      $('caption').textContent = opener;
      $('liveLine').textContent = opener;
      if ($('ariaLine')) $('ariaLine').textContent = opener;
      return;
    }
    $('bubbleName').textContent = 'Aria';
    $('liveName').textContent = 'Aria';
    const text = eng.p.name
      ? 'Hey ' + eng.p.name + '. Where on the map should we practice?'
      : "I'm Aria. What should I call you?";
    $('caption').textContent = text;
    $('liveLine').textContent = text;
    const aria = $('ariaLine');
    if (aria) aria.textContent = text;
  }
  async function play(lines) {
    const spoken = offerTracks(lines && lines.length ? lines : [{ speaker: 'aria', text: 'I heard you. Tell me what you want to practice.' }]).map(present);
    const id = ++playId;
    busy = true; stopSpeaking = false; ttsOnset = 0;
    if (!handsFreeOn()) stopListening();
    browserToken++;
    if (synth) { try { synth.cancel(); } catch (e) {} }
    spoken.forEach(shown => {
      if (shown && shown.speaker !== 'user') lastCoachLine = shown.text || '';
      show(shown);
      setCaption(shown);
    });
    setStatus('speaking', spoken[0] && spoken[0].text);
    try {
      for (const shown of spoken) {
        if (shown.emotion && face) face.react(shown.emotion);
        setAvatarState('speaking', { speaker: shown.speaker });
        if (id !== playId) return;
        await speak(shown);
        if (id !== playId) return;
      }
    } finally {
      if (id === playId) {
        const last = spoken.length ? present(spoken[spoken.length - 1]) : null;
        setAvatarState('idle', { speaker: (last && last.speaker) || 'aria' });
        busy = false;
        spokeUntil = Date.now();
        save();
        if (spoken.some(l => l && /Scorecard\./.test(l.text || ''))) showScorecard();
        settleMic();
      }
    }
  }
  function settleMic() {
    if (hostLock || !rec || document.visibilityState === 'hidden') {
      if (!listening) setStatus('ready', handsFreeOn() ? '' : 'Tap to talk');
      return;
    }
    if (handsFreeOn()) {
      if (!listening) setTimeout(listen, 250);
      if (useEnergyVad()) openVad();
      return;
    }
    if (armListen) {
      armListen = false;
      setTimeout(listen, 200);
      return;
    }
    setStatus('ready', 'Tap to talk');
  }
  function showScorecard() {
    const box = $('scorecard');
    const body = $('scorecardBody');
    if (!box || !body) return;
    const D = window.BrimDelivery;
    if (!D || (!eng.lastGoal && !eng.lastDelivery) || eng.mode === 'scenario' || eng.mode === 'quiz' || eng.mode === 'drill') {
      box.hidden = true;
      return;
    }
    const parts = [];
    if (eng.lastGoal) parts.push(D.formatGoal(eng.lastGoal));
    if (eng.lastDelivery) parts.push(D.formatCard(eng.lastDelivery));
    body.textContent = parts.join(' ');
    box.hidden = false;
  }
  let liveWork = null;
  function releaseWork() {
    if (quiz) quiz = null;
    if (loopRun) { loopRun = null; loopGen++; }
    if (eng.act || eng.mode === 'quiz' || eng.mode === 'drill' || eng.mode === 'scenario' || eng.mode === 'reflect') eng.exitActivity();
    liveWork = null;
  }
  function ownerNow() {
    if (hostSession && hostSession.coachId) return hostSession.coachId;
    if (eng.activeCoach) return eng.activeCoach;
    if (document.body.dataset.view === 'area') return 'amara';
    return 'aria';
  }
  function coachForActivity(a) {
    if (!a) return 'amara';
    if (a.id === 'secplus-701' || a.id === 'interruptions') return 'marcus';
    const ids = ((content[a.id] && content[a.id].characters) || []).map(ch => ch.id);
    if (ids.indexOf('marcus') >= 0) return 'marcus';
    if (ids.indexOf('jasmine') >= 0) return 'jasmine';
    if (ids.indexOf('renee') >= 0) return 'renee';
    if (ids.indexOf('amara') >= 0) return 'amara';
    if (ids.indexOf('aria') >= 0 && ids.length === 1) return 'aria';
    const dest = destinations.find(d => d.activityId === a.id);
    if (dest && DEST_COACH[dest.id]) return DEST_COACH[dest.id];
    return 'amara';
  }
  function bindCoach(coachId, topic, opts) {
    if (!coachId || coachId === 'aria') {
      hostSession = null;
      if ($('visitCard')) $('visitCard').hidden = true;
      return;
    }
    eng.activeCoach = coachId;
    hostSession = {
      coachId: coachId,
      topic: topic || '',
      goal: (eng.p.goal || '').trim(),
      ariaSummary: ariaSummary(),
      userLine: '',
      lastExchange: '',
      lastTopic: '',
      direct: true
    };
    const coach = cast.find(c => c.id === coachId);
    if (coach && !(opts && opts.quiet)) showVisit(coach);
  }
  async function send(text) {
    const value = (text || '').trim();
    if (!value) return;
    unlockAudio();
    greeted = true;
    openerHeard = true;
    if ($('hearAria')) $('hearAria').hidden = true;
    if ($('micLabel')) $('micLabel').textContent = 'Tap to Talk';
    const named = BrimLibrary.keywordIntent(value);
    const leaving = wantsAria(value) || !!named;
    if (!leaving && !isTrackCommand(value) && loopRun && !loopRun.waiting && liveWork && liveWork.owner === ownerNow()) return;
    interrupt();
    show({ speaker: 'user', text: value });
    setStatus('heard', value);
    await new Promise(resolve => setTimeout(resolve, 0));
    setStatus('thinking');
    if ((localStorage.getItem(GEMINI_KEY) || localStorage.getItem(ELEVEN_KEY)) && synth) {
      markLatency('ack', 'One moment');
      speakChunk('One moment.', null, 1, 1, null);
    }
    if (leavesTrack(value)) track = null;
    else if (isTrackCommand(value) || track) {
      try {
        const handled = await routeTrack(value);
        if (handled !== false) return;
      } catch (e) {
        setStatus('error', 'The practice reply failed.');
        await play([{ speaker: 'aria', text: 'I heard you. I am still here. Say vocabulary or public speaking, or tell me what you want to practice.' }]);
        return;
      }
    }
    if (leaving) releaseWork();
    if (wantsAria(value)) { await returnToAria(); return; }
    if (named) { await beginHandoff(named, value); return; }
    if (liveWork && liveWork.owner !== ownerNow()) releaseWork();
    if (loopRun && loopRun.waiting && liveWork && liveWork.owner === ownerNow()) { await continueLoop(value); return; }
    if (quiz && liveWork && liveWork.kind === 'library-quiz' && liveWork.owner === ownerNow()) { await gradeQuiz(value); return; }
    if (window.BrimGym && BrimGym.asksReturn(value)) {
      const who = hostSession && hostSession.coachId ? hostSession.coachId : 'aria';
      await play([{ speaker: who, text: BrimGym.returnLine(BrimGym.loadProfile()) }]);
      return;
    }
    if (hostSession && !eng.act && !loopRun) { await coachTurn(value); return; }
    if (!eng.act && (eng.mode === 'menu' || eng.mode === 'askname' || eng.mode === 'area')) {
      const intent = await detectIntent(value);
      if (intent) { releaseWork(); await beginHandoff(intent, value); return; }
    }
    try {
      const emotion = (await import('./avatar/lipsync.js')).emotionFromText(value);
      if (emotion && face) face.react(emotion);
    } catch (e) {}
    setAvatarState('thinking', { speaker: 'coach' });
    setStatus('thinking');
    if (!eng.act && !quiz && !loopRun && window.BrimContext && BrimContext.asks(value)) {
      const factual = await factualReply(value);
      if (factual) { await play([{ speaker: 'aria', text: factual }]); return; }
    }
    if (pendingHeard) { eng._heard = pendingHeard; pendingHeard = null; }
    else { eng._heard = null; markLatency('stt-end', 'typed'); }
    let lines;
    try { lines = await eng.handle(value); }
    catch (e) {
      setStatus('error', 'The reply failed.');
      lines = [{ speaker: 'aria', text: 'I heard you. I hit a snag, so I am answering from the practice script. Tell me what you want to practice.' }];
    }
    if (!lines || !lines.length) lines = [{ speaker: 'aria', text: 'I heard you. Tell me what you want to practice.' }];
    if (eng.act && eng.act.id === 'current-affairs' && eng.s && eng.s.turn === 0) await dressAffairs(lines);
    if (eng.act) {
      const coachId = coachForActivity(eng.act);
      eng.activeCoach = coachId;
      if (!liveWork || liveWork.lessonId !== eng.act.id) liveWork = { owner: coachId, kind: eng.act.type, lessonId: eng.act.id };
      if (!hostSession || hostSession.coachId !== coachId) bindCoach(coachId, eng.act.title);
    }
    if ((eng.mode === 'area' || eng.mode === 'reflect') && eng.area) { setRoute('#/area/' + eng.area.id); showArea(eng.area); }
    else showHome();
    await play(lines);
  }
  function isTrackCommand(text) {
    return /^(vocabulary|word of the day|public speaking)\b/i.test(String(text || '').trim());
  }
  async function vocabApi() {
    if (!window.BrimVocab) return null;
    if (!BrimVocab.byId('brief')) {
      try { BrimVocab.load(await (await fetch('data/vocabulary.json')).json()); }
      catch (e) { BrimVocab.load({ words: [], topics: [] }); }
    }
    return BrimVocab;
  }
  function saveVocab(state) {
    if (!window.BrimGym) return;
    const profile = BrimGym.loadProfile();
    profile.vocab = state;
    BrimGym.saveProfile(profile);
  }
  async function maybePersonalize(word) {
    if (!word || !localStorage.getItem(GEMINI_KEY) || llm.overLimit()) return word;
    try {
      const raw = await llm.generate([
        'Personalize one example sentence for an adult learner. Use the word exactly once.',
        'Word: ' + word.word + '. Meaning: ' + word.meaning + '.',
        'Goal: ' + (eng.p.goal || 'none') + '.',
        'Return JSON {"example":"one sentence"} and nothing else.'
      ].join('\n'), null);
      const clean = String(raw || '').replace(/```json|```/g, '').trim();
      let j = null;
      try { j = JSON.parse(clean); } catch (e) {
        const m = clean.match(/\{[\s\S]*\}/);
        if (m) { try { j = JSON.parse(m[0]); } catch (e2) { j = null; } }
      }
      const example = j && String(j.example || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      if (example && new RegExp('\\b' + word.word + '\\b', 'i').test(example)) return Object.assign({}, word, { example: example });
    } catch (e) {}
    return word;
  }
  async function maybeTopic(fallback) {
    if (!localStorage.getItem(GEMINI_KEY) || llm.overLimit()) return fallback;
    try {
      const raw = await llm.generate('One public-speaking topic, six words or fewer, for this goal: ' + (eng.p.goal || 'speaking clearly') + '. JSON {"topic":"..."} only.', null);
      const clean = String(raw || '').replace(/```json|```/g, '').trim();
      let j = null;
      try { j = JSON.parse(clean); } catch (e) {
        const m = clean.match(/\{[\s\S]*\}/);
        if (m) { try { j = JSON.parse(m[0]); } catch (e2) { j = null; } }
      }
      const topic = j && String(j.topic || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (topic) return topic;
    } catch (e) {}
    return fallback;
  }
  async function openVocab(skipId) {
    const api = await vocabApi();
    if (!api) {
      await play([{ speaker: 'aria', text: 'I heard you. Vocabulary is not loaded, so tell me what you want to practice.' }]);
      return;
    }
    const picked = api.wordFor(window.BrimGym ? BrimGym.loadProfile().vocab : null, Date.now(), skipId ? { skipId: skipId } : null);
    if (!picked.word) {
      await play([{ speaker: 'aria', text: 'I heard you. I do not have a word list yet. Tell me what you want to practice.' }]);
      return;
    }
    const shown = await maybePersonalize(picked.word);
    saveVocab(picked.track);
    track = { kind: 'vocab', wordId: shown.id, phase: 'sentence' };
    const pals = api.companions(picked.track, shown).map(w => w.word + ': ' + w.meaning + ' Example: ' + w.example).join(' ');
    await play([
      { speaker: 'aria', text: 'Word of the day: ' + shown.word + '. It means ' + shown.meaning + ' Example: ' + shown.example },
      { speaker: 'aria', text: (pals ? 'Also at your level. ' + pals + ' ' : '') + 'Use ' + shown.word + ' in one spoken sentence.' }
    ]);
  }
  async function openSpeech(value) {
    const api = await vocabApi();
    const explicit = api ? api.speechTopic(value, Date.now()) : 'a habit you want to keep';
    const named = /\bpublic speaking\b(?:\s+(?:about|on)\s+|\s+)\S/i.test(value);
    const topic = named ? explicit : await maybeTopic(explicit);
    if (api && window.BrimGym) {
      const state = api.sanitize(BrimGym.loadProfile().vocab);
      state.speechTopic = topic;
      saveVocab(state);
    }
    track = { kind: 'speech', topic: topic, phase: 'talk' };
    await play([{ speaker: 'aria', text: api ? api.speechInvite(topic) : ('Public speaking. Give me about sixty seconds on ' + topic + '. I will score fillers, pace, and pauses, then give one tip.') }]);
  }
  async function routeTrack(value) {
    releaseWork();
    hostSession = null;
    hostLock = false;
    if (/^(vocabulary|word of the day)\b/i.test(value)) { track = null; await openVocab(); return true; }
    if (/^public speaking\b/i.test(value)) { track = null; await openSpeech(value); return true; }
    if (!track) { await play([{ speaker: 'aria', text: 'I heard you. Tell me what you want to practice.' }]); return true; }
    const api = await vocabApi();
    if (!api) { track = null; await play([{ speaker: 'aria', text: 'I heard you. Tell me what you want to practice.' }]); return; }
    if (track.kind === 'vocab') {
      if (/\bnext word\b/i.test(value)) { await openVocab(track.wordId); return; }
      const state = api.sanitize(BrimGym.loadProfile().vocab);
      const word = api.byId(track.wordId) || api.byId(state.todayId);
      const graded = api.gradeSentence(state, value, word, Date.now());
      saveVocab(graded.track);
      await play([{ speaker: 'aria', text: graded.line }]);
      return true;
    }
    if (track.phase === 'done') {
      if (/^(retry|again)\b/i.test(value)) {
        track.phase = 'talk';
        await play([{ speaker: 'aria', text: api.speechRetry(track.topic) }]);
        return true;
      }
      track = null;
      return false;
    }
    const heard = pendingHeard;
    pendingHeard = null;
    const utter = heard && heard.start != null ? [{ text: value, start: heard.start, end: heard.end }] : [];
    const card = window.BrimDelivery ? BrimDelivery.deliveryCard(utter, value) : { fillers: 0, wpm: null, pauseCount: 0, pauseMs: 0, tip: 'Say the point in one breath, then stop.' };
    const short = (heard && heard.end - heard.start < 20000) || value.split(/\s+/).filter(Boolean).length < 20;
    if (short) card.tip = 'That was short of a minute. On the retry, keep one point going until the minute is up.';
    eng.lastGoal = null;
    eng.lastDelivery = card;
    track.phase = 'done';
    const state = api.sanitize(BrimGym.loadProfile().vocab);
    state.speechTopic = track.topic;
    saveVocab(state);
    await play([{ speaker: 'aria', text: 'That was the sixty-second rep on ' + track.topic + '. ' + (window.BrimDelivery ? BrimDelivery.formatCard(card) : card.tip) + ' Say retry for the same topic.' }]);
    return true;
  }
  let speechGen = 0;
  function interrupt() {
    speechGen++;
    stopPulse();
    stopSpeaking = true;
    playId++;
    busy = false;
    stopPlayback();
    if (synth) synth.cancel();
    if (face) face.interrupt();
  }

  function canBarge() { return !!(busy && ttsOnset && (performance.now() - ttsOnset) >= 350); }
  function recentRestartCount() {
    const nowMs = Date.now();
    recRestarts = recRestarts.filter(t => nowMs - t < 10000);
    return recRestarts.length;
  }
  function releaseVad() {
    if (vadTimer) cancelAnimationFrame(vadTimer);
    vadTimer = 0;
    if (vadStream) { try { vadStream.getTracks().forEach(t => t.stop()); } catch (e) {} }
    vadStream = null;
    if (vadCtx) { try { vadCtx.close(); } catch (e) {} }
    vadCtx = null;
    vadAnalyser = null;
    vadState = { hotSince: 0, speaking: false, coolSince: 0 };
  }
  function pumpVad() {
    if (!vadAnalyser || !window.BrimVad) return;
    const bytes = new Uint8Array(vadAnalyser.fftSize || 512);
    try { vadAnalyser.getByteTimeDomainData(bytes); } catch (e) { return; }
    vadState = BrimVad.vadStep(vadState, BrimVad.rmsFromTimeDomain(bytes), performance.now());
    if (vadState.speaking && canBarge()) interrupt();
    vadTimer = requestAnimationFrame(pumpVad);
  }
  async function openVad() {
    if (!useEnergyVad() || vadStream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.BrimVad) return false;
    try {
      vadStream = await navigator.mediaDevices.getUserMedia(BrimVad.MIC_CONSTRAINTS);
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { releaseVad(); return false; }
      vadCtx = new AC();
      if (vadCtx.state === 'suspended') { try { await vadCtx.resume(); } catch (e) {} }
      const src = vadCtx.createMediaStreamSource(vadStream);
      vadAnalyser = vadCtx.createAnalyser();
      vadAnalyser.fftSize = 512;
      src.connect(vadAnalyser);
      pumpVad();
      return true;
    } catch (e) {
      releaseVad();
      return false;
    }
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  if (SR && window.isSecureContext) {
    rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = e => {
      let interim = '';
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const bit = (e.results[i][0] && e.results[i][0].transcript) || '';
        if (e.results[i].isFinal) finalText += bit;
        else interim += bit;
      }
      const Vad = window.BrimVad;
      if (interim && canBarge()) {
        const words = interim.trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2 && !(Vad && Vad.isEcho(interim, lastCoachLine))) interrupt();
      }
      if (finalText.trim()) { acceptHeard(finalText, 'recognition final'); return; }
      const snap = interim.trim();
      if (snap.split(/\s+/).filter(Boolean).length < 2) return;
      clearTimeout(interimTimer);
      interimTimer = setTimeout(() => acceptHeard(snap, 'stable interim'), 1200);
    };
    rec.onend = () => {
      listening = false;
      $('mic').classList.remove('on');
      const intentional = recIntentional;
      recIntentional = false;
      if (document.body.dataset.voice === 'listening' && !busy) setAvatarState('idle', { speaker: 'coach' });
      if (lastRecError === 'audio-capture') {
        releaseVad();
        vadBlocked = true;
        audioFails += 1;
        lastRecError = '';
        if (audioFails === 1) {
          setStatus('error', 'Microphone was busy. Trying once more.');
          setTimeout(listen, 400);
          return;
        }
        setStatus('error', 'Microphone was busy. Tap to talk.');
        return;
      }
      const keep = handsFreeOn() && !hostLock && misses < 99 && document.visibilityState === 'visible';
      if (!keep || intentional || !window.BrimVad) {
        if (!gotResult && !intentional) setStatus('ready', 'Tap to talk');
        return;
      }
      const decision = BrimVad.recognitionRestart(lastRecError || (gotResult ? 'end' : 'no-speech'), { intentional: false, restarts: recentRestartCount() });
      lastRecError = '';
      if (decision.giveUp) {
        if (decision.reason === 'restart-cap') setStatus('error', 'Microphone kept restarting. Tap to talk.');
        if (decision.reason === 'blocked') setStatus('error', 'Microphone blocked. Tap the lock icon and allow it.');
        return;
      }
      if (decision.restart) {
        recRestarts.push(Date.now());
        setTimeout(listen, decision.delay);
      }
    };
    rec.onerror = e => {
      lastRecError = (e && e.error) || '';
      if (lastRecError === 'not-allowed' || lastRecError === 'service-not-allowed') {
        misses = 99;
        setStatus('error', 'Microphone blocked. Tap the lock icon and allow it.');
      }
      if (lastRecError === 'audio-capture') {
        releaseVad();
        vadBlocked = true;
        setStatus('error', 'Microphone was busy. Tap to talk.');
      }
    };
  } else $('note').textContent = !window.isSecureContext
    ? 'Microphone needs a secure (https) link. You can type for now.'
    : 'Speech recognition is not supported in this browser (use Chrome). You can type instead. The coach still talks.';
  function listen() {
    if (!rec || listening) return;
    if (busy && !handsFreeOn()) return;
    gotResult = false;
    recIntentional = false;
    try {
      rec.start();
      listening = true;
      recStartedAt = Date.now();
      $('mic').classList.add('on');
      setStatus('listening');
      setAvatarState('listening', { speaker: 'coach' });
    } catch (e) {
      if (e && /InvalidStateError/i.test(String(e.name || e.message || ''))) { listening = true; setStatus('listening'); return; }
      setStatus('error', 'The microphone did not start.');
    }
  }
  function stopListening() {
    clearTimeout(interimTimer);
    if (!(rec && listening)) return;
    recIntentional = true;
    try { rec.abort(); } catch (e) {}
    listening = false;
    $('mic').classList.remove('on');
  }
  $('mic').onclick = () => {
    unlockAudio();
    misses = 0;
    recRestarts = [];
    audioFails = 0;
    if (!openerHeard) {
      openerHeard = true;
      greeted = true;
      if ($('hearAria')) $('hearAria').hidden = true;
      $('micLabel').textContent = 'Tap to Talk';
      armListen = true;
      play([{ speaker: 'aria', text: opener || scriptedOpener() }]);
      return;
    }
    if (!greeted) {
      greeted = true;
      const line = !eng.p.name
        ? "Welcome to Brimmesa. I'm Aria. What should I call you?"
        : 'Welcome back, ' + eng.p.name + '. Pick a glowing stop, or tell me where you want to practice.';
      armListen = true;
      play([{ speaker: 'aria', text: line }]);
      return;
    }
    if (busy) {
      interrupt();
      listen();
      return;
    }
    if (listening) { misses = 99; stopListening(); setStatus('ready', 'Mic off'); setAvatarState('idle', { speaker: 'coach' }); return; }
    interrupt();
    listen();
  };
  if ($('vocabGo')) $('vocabGo').onclick = () => { unlockAudio(); send('vocabulary'); };
  if ($('speechGo')) $('speechGo').onclick = () => { unlockAudio(); send('public speaking'); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      stopListening();
      releaseVad();
      if (synth) synth.cancel();
      return;
    }
    if (face && want3d() && document.body.dataset.view === 'home') {
      face.setVisible(true);
      face.kick();
      refresh3dStatus();
    }
  });
  window.addEventListener('resize', () => { if (face) face.kick(); if (window.BrimWalk && BrimWalk.resize) BrimWalk.resize(); });

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
  function showWorld(name) {
    const ids = { map: 'viewMap', missions: 'viewMissions', coaches: 'viewCoaches', scenarios: 'viewScenarios', library: 'viewLibrary', progress: 'viewProgress' };
    document.body.dataset.view = name;
    Object.entries(ids).forEach(([key, id]) => { const node = $(id); if (node) node.hidden = key !== name; });
    document.querySelectorAll('.bottomnav button').forEach(btn => btn.classList.remove('on'));
    const tab = { map: 'tabMap', missions: 'tabMissions', coaches: 'tabCoaches', scenarios: 'tabScenarios', library: 'tabLibrary', progress: 'tabProgress' }[name];
    if ($(tab)) $(tab).classList.add('on');
    if (name === 'missions') renderMissions();
    if (name === 'coaches') renderCoaches();
    if (name === 'scenarios') renderScenarios();
    if (name === 'library') renderLibrary();
    if (name === 'progress') renderProgress();
    if (name !== 'map') hideTalk();
    syncPresenter(document.body.dataset.voice || 'idle', '');
    if (face) face.setVisible(false);
    const shell = document.querySelector('.shell');
    if (shell) shell.hidden = true;
    const timeline = $('timeline');
    if (timeline) timeline.hidden = true;
  }
  function showHome(opts) {
    $('areaView').hidden = true;
    if (!opts || !opts.keepHash) setRoute('#/');
    document.querySelectorAll('[data-area]').forEach(btn => btn.classList.remove('on'));
    document.body.classList.remove('nav-open');
    showWorld('map');
  }
  function showArea(area) {
    document.body.dataset.view = 'area';
    const shell = document.querySelector('.shell');
    if (shell) shell.hidden = false;
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
    syncPresenter(document.body.dataset.voice || 'idle', '');
  }
  function launchActivity(a) {
    if (!a) return;
    unlockAudio();
    greeted = true;
    if (eng.p.driving && !a.driving) {
      showHome();
      play([eng.C("That one needs your full attention, so let's save it for when you're parked. Try communication or Security plus.")]);
      return;
    }
    releaseWork();
    const card = $('scorecard');
    if (card) card.hidden = true;
    const coachId = coachForActivity(a);
    eng.activeCoach = coachId;
    liveWork = { owner: coachId, kind: a.type, lessonId: a.id };
    bindCoach(coachId, a.title);
    show({ speaker: 'user', text: a.title });
    showHome();
    const lines = eng.start(a);
    if (a.id === 'current-affairs') { dressAffairs(lines).then(play); return; }
    play(lines);
  }
  async function dressAffairs(lines) {
    let snap = window.BrimContext ? BrimContext.snapshot() : null;
    if (window.BrimContext) {
      try { snap = await BrimContext.ensure({ news: true }); } catch (e) {}
      eng.liveBrief = BrimContext.prompt();
    }
    const story = window.BrimContext ? BrimContext.leadStory(snap) : null;
    if (eng.s) eng.s.story = story;
    if (lines && lines[0]) lines[0] = { speaker: 'renee', text: BrimContext.affairsLine(story) };
    return lines;
  }
  async function factualReply(value) {
    if (!window.BrimContext || !BrimContext.asks(value)) return '';
    let snap = BrimContext.snapshot();
    if (BrimContext.asksNews(value)) {
      try { snap = await BrimContext.ensure({ news: true }); } catch (e) {}
    }
    eng.liveBrief = BrimContext.prompt();
    return BrimContext.answer(value, snap) || '';
  }
  function paintContext(snap) {
    const node = $('contextStatus');
    if (!node || !snap) return;
    const w = snap.weather || {};
    node.textContent = w.tag === 'LIVE'
      ? 'Weather: ' + w.summary + '. ' + (w.source || 'Open-Meteo') + '.'
      : 'Weather: not loaded' + (w.reason ? ' (' + w.reason + ')' : '') + '.';
    if (snap.holidays && snap.holidays.today) node.textContent += ' Today: ' + snap.holidays.today + '.';
  }
  function launchArea(id) {
    const area = areas.find(a => a.id === id);
    if (!area) return;
    unlockAudio();
    greeted = true;
    releaseWork();
    hostSession = null;
    eng.activeCoach = null;
    if ($('visitCard')) $('visitCard').hidden = true;
    setRoute('#/area/' + id);
    showArea(area);
    play(eng.openArea(area));
  }
  function launchReflection(id) {
    const area = areas.find(a => a.id === id);
    if (!area) return;
    unlockAudio();
    greeted = true;
    releaseWork();
    hostSession = null;
    eng.activeCoach = 'amara';
    liveWork = { owner: 'amara', kind: 'reflect', lessonId: id };
    if ($('visitCard')) $('visitCard').hidden = true;
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
      b.onclick = () => { const dest = destinations.find(d => d.id === AREA_DEST[area.id]); if (dest) selectDestination(dest); launchArea(area.id); };
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
      b.onclick = () => activateCoach(c.id);
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
      b.onclick = () => { const dest = destinations.find(d => d.id === AREA_DEST[area.id]); if (dest) selectDestination(dest); launchArea(area.id); };
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
    renderMission();
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
  let contextAsideUsed = false;
  function openSettings() {
    paintGemini();
    paintVoices();
    loadElevenVoices();
    if (window.BrimContext) paintContext(BrimContext.snapshot());
    $('settingsDlg').showModal();
  }
  $('settingsBtn').onclick = openSettings;
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
  window.BrimFuture = BrimEngine.futureHooks || { realisticAvatar: { implemented: false }, heygen: { implemented: false } };
  window.BrimFuture.walkTo = {
    implemented: true,
    async play(opts) {
      if (!window.BrimWalk) return false;
      return window.BrimWalk.play(opts || {});
    }
  };
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
  $('tabMap').onclick = () => showHome();
  $('tabMissions').onclick = () => showWorld('missions');
  $('tabCoaches').onclick = () => showWorld('coaches');
  $('tabScenarios').onclick = () => showWorld('scenarios');
  $('tabLibrary').onclick = () => showWorld('library');
  $('tabProgress').onclick = () => showWorld('progress');
  $('tabSettings').onclick = () => openSettings();
  if ($('contextCitySave')) $('contextCitySave').onclick = async () => {
    const city = ($('contextCity').value || '').trim();
    if (!city || !window.BrimContext) return;
    if ($('contextStatus')) $('contextStatus').textContent = 'Looking up ' + city + '.';
    try {
      const snap = await BrimContext.useCity(city);
      eng.liveBrief = BrimContext.prompt();
      paintContext(snap);
    } catch (e) {
      if ($('contextStatus')) $('contextStatus').textContent = "I could not find that city. Weather stays unloaded.";
    }
  };
  if ($('contextLocate')) $('contextLocate').onclick = async () => {
    if (!window.BrimContext) return;
    if ($('contextStatus')) $('contextStatus').textContent = 'Asking this device for a location.';
    try {
      const snap = await BrimContext.useDevice();
      eng.liveBrief = BrimContext.prompt();
      paintContext(snap);
    } catch (e) {
      if ($('contextStatus')) $('contextStatus').textContent = 'This device did not share a location. You can type a city or decline.';
    }
  };
  if ($('contextDecline')) $('contextDecline').onclick = () => {
    if (!window.BrimContext) return;
    const snap = BrimContext.decline();
    eng.liveBrief = BrimContext.prompt();
    paintContext(snap);
  };

  function missionFor(id) { return (eng.p.missions || {})[id] || null; }
  let selectedDestId = null;
  const AREA_DEST = { mindset: 'mindset', health: 'health', career: 'career', business: 'wealth', relationships: 'relationships', lifestyle: 'lifestyle', estate: 'wealth', spirit: 'mindset', affairs: 'affairs' };
  const DEST_COACH = { skills: 'marcus', career: 'marcus', mindset: 'amara', wealth: 'amara', relationships: 'jasmine', lifestyle: 'renee', travel: 'renee', health: 'amara', central: 'aria', affairs: 'renee' };
  function renderMission() {
    const title = $('missionTitle');
    if (!title) return;
    const next = destinations.find(d => d.id === selectedDestId);
    if (!next) {
      title.textContent = 'Choose a destination';
      $('missionText').textContent = 'Tap a glowing stop. Aria will start the spoken practice.';
      $('missionGo').textContent = 'Start';
      $('missionGo').onclick = () => {};
      return;
    }
    title.textContent = next.title;
    $('missionText').textContent = next.blurb || 'Spoken practice.';
    const done = next.activityId && missionFor(next.activityId);
    $('missionGo').textContent = next.id === 'central' ? 'Talk to Aria' : (done ? 'Practice again' : 'Start');
    $('missionGo').onclick = () => startDestination(next);
  }
  function selectDestination(d) {
    if (!d) return;
    hideTalk();
    selectedDestId = d.id;
    document.querySelectorAll('.hotspot').forEach(btn => btn.classList.toggle('on', btn.dataset.dest === d.id));
    renderMission();
  }
  function renderMissions() {
    const list = $('missionList');
    if (!list) return;
    list.replaceChildren();
    destinations.filter(d => d.activityId).forEach(d => {
      const done = missionFor(d.activityId);
      const b = el('button', 'list-card');
      b.type = 'button';
      b.append(el('strong', null, d.title), el('small', null, (done ? 'Done · best ' + done.score + '. ' : 'Not finished. ') + (d.blurb || '')));
      b.onclick = () => startDestination(d);
      list.append(b);
    });
  }
  function renderCoaches() {
    const grid = $('coachGrid');
    if (!grid || grid.childElementCount) return;
    cast.forEach(c => {
      const b = el('button', 'list-card');
      b.type = 'button';
      if (c.id === 'aria') b.classList.add('featured');
      const img = el('img');
      img.src = c.portrait;
      img.alt = 'Portrait of ' + c.name;
      b.append(img, el('strong', null, c.name), el('small', null, c.id === 'aria' ? 'Your guide · ' + c.role : c.role));
      b.onclick = () => activateCoach(c.id);
      grid.append(b);
    });
  }
  function renderScenarios() {
    const list = $('scenarioList');
    if (!list) return;
    list.replaceChildren();
    eng.activities().forEach(a => {
      const b = el('button', 'list-card');
      b.type = 'button';
      const m = eng.p.mastery[content[a.id].skill];
      b.append(el('strong', null, a.title), el('small', null, (m && m.attempts ? 'Best ' + m.best + '. ' : '') + a.world));
      b.onclick = () => launchActivity(a);
      list.append(b);
    });
  }
  function renderProgress() {
    if ($('progressLead')) $('progressLead').textContent = eng.progressSummary();
    renderProfile();
    const list = $('progressList');
    if (!list) return;
    list.replaceChildren();
    (eng.p.history || []).slice(0, 8).forEach(h => {
      const row = el('article', 'list-card');
      row.append(el('strong', null, h.activity + ' · ' + h.score), el('small', null, h.summary || ''));
      list.append(row);
    });
  }
  function startDestination(d) {
    if (!d) return;
    unlockAudio();
    greeted = true;
    selectDestination(d);
    showHome();
    if (!d.activityId || d.id === 'central') { activateCoach('aria'); return; }
    const act = activityById(d.activityId);
    if (act) { launchActivity(act); return; }
    const coachId = DEST_COACH[d.id];
    if (coachId && coachId !== 'aria') { activateCoach(coachId); return; }
    const area = areas.find(a => a.id === d.id);
    if (area) launchArea(area.id);
  }
  function openCentral() {
    unlockAudio();
    greeted = true;
    const goal = eng.p.goal ? ' I remember your goal: ' + eng.p.goal + '.' : '';
    const name = eng.p.name ? eng.p.name + ', ' : '';
    play([{ speaker: 'aria', text: name + 'this is Brimmesa Central.' + goal + ' Choose a glowing stop and say the scene out loud. I will score clarity, confidence, and warmth.' }]);
  }
  function setupMap() {
    const host = $('hotspots');
    const stage = $('mapStage');
    const world = $('mapWorld');
    if (!host || !stage || !world) return;
    destinations.forEach(d => {
      const b = el('button', 'hotspot');
      b.type = 'button';
      b.style.left = d.x + '%';
      b.style.top = d.y + '%';
      b.dataset.dest = d.id;
      b.setAttribute('aria-label', d.title);
      const dot = document.createElement('i');
      const label = el('span', null, d.id === 'central' ? 'Central' : d.title.split(' ')[0]);
      b.append(dot, label);
      b.onclick = () => { if (stage.dataset.drag === '1') return; selectDestination(d); };
      host.append(b);
    });
    let scale = 1, tx = 0, ty = 0;
    const pointers = new Map();
    let pinch = 0;
    function apply() {
      world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }
    function clamp() {
      const w = stage.clientWidth, h = stage.clientHeight;
      const minX = Math.min(0, w - w * scale), minY = Math.min(0, h - h * scale);
      tx = Math.max(minX, Math.min(0, tx));
      ty = Math.max(minY, Math.min(0, ty));
    }
    function zoomAt(next) {
      const prev = scale;
      scale = Math.max(1, Math.min(3.2, next));
      const w = stage.clientWidth, h = stage.clientHeight;
      tx = (tx - w / 2) * (scale / prev) + w / 2;
      ty = (ty - h / 2) * (scale / prev) + h / 2;
      clamp(); apply();
    }
    $('zoomIn').onclick = () => zoomAt(scale * 1.25);
    $('zoomOut').onclick = () => zoomAt(scale / 1.25);
    $('zoomFit').onclick = () => { scale = 1; tx = 0; ty = 0; apply(); };
    stage.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) { stage.dataset.drag = '0'; return; }
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY });
      stage.dataset.drag = '0';
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      }
    });
    stage.addEventListener('pointermove', e => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (Math.hypot(e.clientX - prev.ox, e.clientY - prev.oy) > 8) stage.dataset.drag = '1';
      if (stage.dataset.follow === '1') {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, ox: prev.ox, oy: prev.oy });
        return;
      }
      if (pointers.size === 1) { tx += e.clientX - prev.x; ty += e.clientY - prev.y; }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, ox: prev.ox, oy: prev.oy });
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinch) zoomAt(scale * (dist / pinch));
        pinch = dist;
      }
      clamp(); apply();
    });
    const end = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', e => { e.preventDefault(); zoomAt(scale * (e.deltaY > 0 ? 0.9 : 1.1)); }, { passive: false });
    const goal = $('goalInput');
    if (goal) {
      goal.value = eng.p.goal || '';
      goal.addEventListener('change', () => { eng.p.goal = goal.value.trim(); save(); });
    }
    if ($('progressHistory')) $('progressHistory').onclick = openHistory;
    function pose() {
      return { scale: scale, tx: tx, ty: ty, w: stage.clientWidth, h: stage.clientHeight };
    }
    function look(xPct, yPct, next, opts) {
      opts = opts || {};
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      const goal = window.BrimWorld
        ? BrimWorld.cameraTarget(xPct, yPct, next == null ? scale : next, w, h)
        : { scale: Math.max(1, Math.min(3.2, next || scale)), tx: tx, ty: ty };
      scale = goal.scale;
      tx = goal.tx;
      ty = goal.ty;
      clamp();
      const ms = opts.instant || opts.ms === 0 ? 0 : (opts.ms || 800);
      world.style.transition = ms ? ('transform ' + ms + 'ms cubic-bezier(.22,.7,.2,1)') : 'none';
      apply();
    }
    function followCam(xPct, yPct, next) {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h || !window.BrimWorld) return;
      const goal = BrimWorld.cameraTarget(xPct, yPct, next || scale, w, h);
      scale += (goal.scale - scale) * 0.22;
      tx += (goal.tx - tx) * 0.22;
      ty += (goal.ty - ty) * 0.22;
      clamp();
      world.style.transition = 'none';
      apply();
    }
    function focus(xPct, yPct) { look(xPct, yPct, 2.2, { ms: 700 }); }
    function fit(opts) {
      scale = 1; tx = 0; ty = 0;
      const ms = opts && opts.instant ? 0 : 700;
      world.style.transition = ms ? ('transform ' + ms + 'ms cubic-bezier(.22,.7,.2,1)') : 'none';
      apply();
    }
    window.BrimMap = { focus: focus, fit: fit, look: look, follow: followCam, pose: pose };
    apply();
  }
  const lib = BrimLibrary.createLibrary({
    get: () => localStorage.getItem('brimmesa.library.v1'),
    set: v => localStorage.setItem('brimmesa.library.v1', v)
  });
  lib.seedSecurityPlus(content['secplus-701']);
  let quiz = null;
  function scriptedOpener() {
    const goal = eng.p.goal ? ' Your goal is ' + eng.p.goal + '.' : '';
    const watched = lib.interests().slice(0, 2).map(r => r.title).filter(Boolean);
    const books = lib.items().filter(it => (it.coaches || []).indexOf('aria') >= 0 || (it.coaches || []).indexOf('shared') >= 0).slice(-2).map(it => it.title);
    const extra = (watched.length ? ' You have been watching ' + watched.join(' and ') + '.' : '') + (books.length ? ' We can use ' + books.join(' and ') + '.' : '');
    if (!eng.p.name) return "I'm Aria. Welcome to Brimmesa." + goal + extra + ' What should I call you?';
    return eng.p.name + ", I'm Aria." + goal + extra + ' Pick a glowing stop, or open the library.';
  }
  function showOpenerText(text) {
    opener = text;
    if ($('hearAria')) $('hearAria').hidden = false;
    if ($('micLabel')) $('micLabel').textContent = 'Tap to hear Aria';
    idleCaption();
  }
  async function prepareOpener() {
    let cached = '';
    try { cached = sessionStorage.getItem('brimmesa.aria.opener') || ''; } catch (e) {}
    showOpenerText(cached || scriptedOpener());
    if (cached || !localStorage.getItem(GEMINI_KEY) || llm.overLimit()) return;
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem(GEMINI_TURNS) || '[]'); } catch (e) {}
    const prompt = [
      'You are Aria, the warm guide for Brimmesa. One or two short spoken sentences. No markdown.',
      'Greet from this context only. Do not invent facts. Write the brand as Brimmesa.',
      'Name: ' + (eng.p.name || 'unknown') + '. Goal: ' + (eng.p.goal || 'none') + '.',
      'Interests: ' + (lib.interests().slice(0, 5).map(r => r.title).join('; ') || 'none') + '.',
      'Library: ' + (lib.items().slice(-5).map(it => it.title).join('; ') || 'none') + '.',
      'Recent: ' + (recent.slice(-4).map(t => (t.role || '') + ' ' + (t.text || '')).join(' | ') || 'none'),
      eng.p.name ? 'Do not ask their name.' : 'Ask what you should call them.'
    ].join('\n');
    try {
      const got = await llm.generate(prompt, null);
      const line = String(got || '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
      if (!line || openerHeard) return;
      try { sessionStorage.setItem('brimmesa.aria.opener', line); } catch (e) {}
      showOpenerText(line);
    } catch (e) {}
  }
  function coachLabel(id) {
    if (id === 'shared') return 'Shared';
    const row = cast.find(c => c.id === id);
    return row ? row.name : id;
  }
  function renderLibrary() {
    const sel = $('libCoach');
    if (sel && !sel.childElementCount) {
      ['shared'].concat(cast.map(c => c.id)).forEach(id => {
        const o = document.createElement('option');
        o.value = id; o.textContent = coachLabel(id); sel.append(o);
      });
    }
    const obj = $('marcusObj');
    if (obj && !obj.childElementCount) {
      (content['secplus-701'].domains || []).forEach(d => {
        const o = document.createElement('option');
        o.value = d.id; o.textContent = d.id + ' ' + d.name; obj.append(o);
      });
    }
    const list = $('libList');
    if (!list) return;
    const coach = sel.value;
    list.replaceChildren();
    lib.items().filter(it => {
      const coaches = it.coaches || [];
      return coach === 'shared' ? coaches.indexOf('shared') >= 0 : coaches.indexOf(coach) >= 0;
    }).forEach(it => {
      const row = el('article', 'list-card');
      const del = el('button', 'ghost', 'Delete');
      del.type = 'button';
      del.onclick = () => { lib.remove(it.id); renderLibrary(); };
      row.append(el('strong', null, it.title), el('small', null, it.sourceType + (it.channel ? ' · ' + it.channel : '') + (it.url ? ' · ' + it.url : '')));
      if (it.attribution) row.append(el('small', null, it.attribution));
      row.append(del);
      list.append(row);
    });
    if (!list.childElementCount) list.append(el('p', 'fine', 'Nothing saved for this coach yet.'));
    const box = $('libInterests');
    box.replaceChildren();
    lib.interests().slice(0, 12).forEach(r => {
      const row = el('article', 'list-card');
      row.append(el('strong', null, r.title), el('small', null, [r.channel, r.at].filter(Boolean).join(' · ')));
      box.append(row);
    });
    if (!box.childElementCount) box.append(el('p', 'fine', 'No watch history yet.'));
    const phish = $('marcusPhish');
    if (phish) {
      const locked = BrimLibrary.challenge('marcus-phish', Object.keys(eng.p.achievements || {})).locked;
      phish.disabled = !!locked;
      phish.textContent = locked ? 'Phishing locked' : 'Phishing challenge';
    }
  }
  function libPanels(lines) {
    const box = $('libraryOut');
    if (!box) return;
    lines.forEach(line => {
      const panel = el('article', 'panel ' + (line.speaker || 'marcus'));
      panel.append(el('p', 'who', line.speaker === 'user' ? 'You' : ((chars[line.speaker] && chars[line.speaker].name) || 'Marcus')), el('p', null, line.text));
      box.append(panel);
    });
    while (box.children.length > 8) box.firstChild.remove();
  }
  function citeLine(hit) {
    if (!hit || hit.citeInConversation === false) return '';
    const when = hit.start == null ? '' : ' at ' + BrimLibrary.fmtTime(hit.start);
    return 'Source: ' + hit.title + (hit.url ? ' ' + hit.url : '') + when + '.';
  }
  function scrubSource(text, hit) {
    let line = String(text || '');
    line = line.replace(/https?:\/\/\S+/gi, '');
    line = line.replace(/\bLink:\s*/gi, '');
    line = line.replace(/\bSource:[^.?!]*[.?!]?/gi, '');
    if (hit && hit.title) line = line.replace(new RegExp(String(hit.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '');
    line = line.replace(/\b(youtube|bosshogg(?: macaroni)?)\b/gi, '');
    return line.replace(/\s+/g, ' ').replace(/\s+([.?!])/g, '$1').trim();
  }
  function scriptedMarcus(hits, query) {
    const item = BrimLibrary.matchItem((content['secplus-701'] && content['secplus-701'].items) || [], query || '');
    if (item) return item.teach + ' ' + item.explain + ' Say that back in one sentence, or ask the next question.';
    const useful = (hits || []).filter(h => h.sourceType !== 'playlist');
    const hit = useful[0] || hits[0];
    const bit = hit ? (hit.citeInConversation === false ? BrimLibrary.lessonText(hit.text) : hit.text) : 'I only teach the Brimmesa outline saved on this device.';
    const sentence = bit.split(/(?<=[.!?])\s/)[0];
    const cite = citeLine(hit);
    return 'Listen. ' + sentence + (cite ? ' ' + cite : '');
  }
  async function marcusSpeak(query) {
    const hits = lib.search(query, { coach: 'marcus', limit: 3 });
    const row = cast.find(c => c.id === 'marcus');
    const top = (hits || []).filter(h => h.sourceType !== 'playlist')[0] || hits[0];
    let text = scriptedMarcus(hits, query);
    if (localStorage.getItem(GEMINI_KEY) && !llm.overLimit()) {
      try {
        const got = await llm.generate(BrimLibrary.retrievalPrompt(row, query, hits), null);
        const clean = String(got || '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 420);
        if (clean) text = clean;
      } catch (e) {}
    }
    const cite = citeLine(top);
    if (cite && text.indexOf('Source:') < 0) text += ' ' + cite;
    if (top && top.citeInConversation === false) text = scrubSource(text, top);
    libPanels([{ speaker: 'marcus', text: text }]);
    play([{ speaker: 'marcus', text: text }]);
  }
  function domainText(id) {
    const dom = (content['secplus-701'].domains || []).find(d => d.id === id);
    return dom ? dom.name : id;
  }
  function askQuiz() {
    const it = quiz.items[quiz.i];
    quiz.askedId = it.id;
    const text = 'Question ' + (quiz.i + 1) + ' of 5. ' + it.q;
    libPanels([{ speaker: 'marcus', text: text }]);
    if ($('marcusQ')) $('marcusQ').placeholder = 'Your answer';
    if (document.body.dataset.view === 'map') play([{ speaker: 'marcus', text: text }]);
  }
  function startQuiz() {
    releaseWork();
    const items = (content['secplus-701'].items || []).slice();
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = items[i]; items[i] = items[j]; items[j] = t; }
    quiz = { items: items.slice(0, 5), i: 0, correct: 0, lessonId: 'secplus-701' };
    liveWork = { owner: 'marcus', kind: 'library-quiz', lessonId: 'secplus-701' };
    eng.activeCoach = 'marcus';
    askQuiz();
  }
  async function gradeQuiz(answer) {
    const it = quiz && quiz.items.find(x => x.id === quiz.askedId);
    if (!it) return;
    const t = answer.toLowerCase();
    const ok = !/\b(don'?t know|no idea|skip|pass)\b/.test(t) && (it.accept || []).some(w => t.includes(String(w).toLowerCase()));
    if (ok) quiz.correct++;
    const reply = (ok ? 'Correct. ' : 'Not quite. ') + it.explain;
    libPanels([{ speaker: 'user', text: answer }, { speaker: 'marcus', text: reply }]);
    quiz.i++;
    if (quiz.i < quiz.items.length) {
      if (document.body.dataset.view === 'map') await play([{ speaker: 'marcus', text: reply }]);
      askQuiz();
      return;
    }
    const score = Math.round(100 * quiz.correct / quiz.items.length);
    const r = BrimEngine.awardXP(eng.p, 'library.secplus', score);
    BrimEngine.touchStreak(eng.p, Date.now());
    eng.p.history.unshift({ t: Date.now(), activity: 'Marcus Security+ quiz', score: score, xp: r.xp, summary: quiz.correct + ' of 5 correct.' });
    eng.p.history = eng.p.history.slice(0, 50);
    eng.p.lastFeedback = 'Marcus Security+ quiz: score ' + score + '. ' + quiz.correct + ' of 5.';
    save();
    renderStats();
    const done = 'Quiz done. ' + quiz.correct + ' of 5. Score ' + score + '. You earned ' + r.xp + ' XP.';
    libPanels([{ speaker: 'marcus', text: done }]);
    quiz = null;
    if (liveWork && liveWork.kind === 'library-quiz') liveWork = null;
    if ($('marcusQ')) $('marcusQ').placeholder = 'Ask Marcus about this objective';
    if (document.body.dataset.view === 'map') await play([{ speaker: 'marcus', text: done }]);
  }
  if ($('libCoach')) $('libCoach').onchange = () => renderLibrary();
  if ($('libAddUrl')) $('libAddUrl').onclick = async () => {
    const url = $('libUrl').value.trim();
    if (!url) return;
    const meta = BrimLibrary.youtube(url);
    let title = meta.sourceType === 'playlist' ? 'YouTube playlist' : 'YouTube video';
    let channel = '';
    if (meta.videoId) {
      try {
        const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
        if (r.ok) { const j = await r.json(); title = j.title || title; channel = j.author_name || ''; }
      } catch (e) {}
    }
    const saved = lib.add({ coaches: [$('libCoach').value], title: title, sourceType: meta.sourceType, url: url, channel: channel, text: title + (channel ? '. Channel: ' + channel + '.' : '.') + ' Title only. No captions were fetched.', hashKey: 'url:' + url });
    $('libNote').textContent = saved.duplicate ? 'Already saved. Not indexed again.' : 'Saved the title. Captions were not downloaded.';
    $('libUrl').value = '';
    renderLibrary();
  };
  if ($('libAddText')) $('libAddText').onclick = () => {
    const text = $('libPaste').value.trim();
    if (!text) return;
    const timed = /-->/.test(text);
    const saved = lib.add({ coaches: [$('libCoach').value], title: text.slice(0, 60), sourceType: timed ? 'transcript' : 'notes', text: text, timed: timed });
    $('libNote').textContent = saved.duplicate ? 'Already saved. Not indexed again.' : 'Saved on this device.';
    $('libPaste').value = '';
    renderLibrary();
  };
  if ($('libFile')) $('libFile').onchange = () => {
    const file = $('libFile').files && $('libFile').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const name = file.name.toLowerCase();
      if (name.endsWith('.json') || name.endsWith('.html') || name.endsWith('.htm')) {
        const merged = lib.mergeInterests(BrimLibrary.parseTakeout(text).map(r => Object.assign({ account: file.name }, r)));
        $('libNote').textContent = 'Watch history: ' + merged.added + ' new titles, ' + merged.total + ' saved.';
      } else {
        const timed = name.endsWith('.vtt') || name.endsWith('.srt') || /-->/.test(text);
        lib.add({ coaches: [$('libCoach').value], title: file.name, sourceType: timed ? 'transcript' : 'notes', text: text, timed: timed });
        $('libNote').textContent = 'Uploaded ' + file.name + '.';
      }
      $('libFile').value = '';
      renderLibrary();
    };
    reader.readAsText(file);
  };
  if ($('marcusTeach')) $('marcusTeach').onclick = () => marcusSpeak('Teach ' + domainText($('marcusObj').value) + ' for Security+ SY0-701');
  if ($('marcusAsk')) $('marcusAsk').onsubmit = e => {
    e.preventDefault();
    const q = $('marcusQ').value.trim();
    if (!q) return;
    $('marcusQ').value = '';
    if (quiz && liveWork && liveWork.kind === 'library-quiz' && liveWork.owner === 'marcus') { gradeQuiz(q); return; }
    marcusSpeak(q);
  };
  if ($('marcusQuiz')) $('marcusQuiz').onclick = () => startQuiz();
  let loopGen = 0;
  function renderDots() {
    const bar = $('loopBar');
    if (!bar) return;
    if (!loopRun) { bar.hidden = true; return; }
    bar.hidden = false;
    const step = BrimLibrary.LOOP[Math.min(loopRun.i, BrimLibrary.LOOP.length - 1)];
    $('loopTitle').textContent = loopRun.spec.title + ' · ' + step.label;
    const ol = $('loopDots');
    ol.replaceChildren();
    BrimLibrary.LOOP.forEach((s, i) => {
      const li = document.createElement('li');
      if (i < loopRun.i) li.className = 'done';
      else if (i === loopRun.i) li.className = 'on';
      li.append(document.createElement('i'), document.createTextNode(s.label));
      ol.append(li);
    });
  }
  async function sayMarcus(text) {
    renderDots();
    await play([{ speaker: 'marcus', text: text }]);
  }
  async function evaluateTurn(text, step) {
    const fallback = BrimLibrary.rubric(text, loopRun.spec, step);
    if (!localStorage.getItem(GEMINI_KEY) || llm.overLimit()) return fallback;
    try {
      const raw = await llm.generate(BrimLibrary.evalPrompt(loopRun.spec, step, text, loopRun.audience), null);
      return BrimLibrary.readScores(raw, fallback);
    } catch (e) { return fallback; }
  }
  async function beginChallenge(id) {
    const spec = BrimLibrary.challenge(id, Object.keys(eng.p.achievements || {}));
    if (!spec || spec.locked) return;
    releaseWork();
    eng.activeCoach = 'marcus';
    liveWork = { owner: 'marcus', kind: 'loop', lessonId: spec.id };
    bindCoach('marcus', spec.title);
    const gen = ++loopGen;
    openerHeard = true;
    greeted = true;
    if ($('hearAria')) $('hearAria').hidden = true;
    $('micLabel').textContent = 'Tap to Talk';
    loopRun = { spec: spec, i: 0, waiting: false, scores: [], audience: spec.audiences[0] };
    showHome();
    await sayMarcus(spec.learn);
    if (gen !== loopGen || !loopRun) return;
    loopRun.i = 1;
    await sayMarcus(spec.explain);
    if (gen !== loopGen || !loopRun) return;
    loopRun.waiting = true;
    renderDots();
  }
  async function continueLoop(text) {
    if (!loopRun) return;
    const gen = ++loopGen;
    const step = BrimLibrary.LOOP[loopRun.i].id;
    loopRun.waiting = false;
    if (step === 'explain') {
      const score = await evaluateTurn(text, 'explain');
      if (gen !== loopGen || !loopRun) return;
      loopRun.explainScore = score;
      loopRun.i = 2;
      await sayMarcus(BrimLibrary.feedbackText(score));
      if (gen !== loopGen || !loopRun) return;
      await sayMarcus(loopRun.spec.practice);
      if (gen !== loopGen || !loopRun) return;
      loopRun.waiting = true;
      renderDots();
      return;
    }
    if (step === 'practice') {
      const score = await evaluateTurn(text, 'practice');
      if (gen !== loopGen || !loopRun) return;
      const note = score.dims.accuracy >= 60 ? 'Ha. You caught it.' : loopRun.spec.practiceFix;
      loopRun.i = 3;
      await sayMarcus(note + ' ' + loopRun.spec.surprise + ' Explain ' + loopRun.spec.concept + ' to ' + loopRun.audience.label + '. ' + loopRun.audience.cue);
      if (gen !== loopGen || !loopRun) return;
      loopRun.waiting = true;
      renderDots();
      return;
    }
    if (step === 'communicate') {
      const score = await evaluateTurn(text, 'communicate');
      if (gen !== loopGen || !loopRun) return;
      loopRun.i = 4;
      await sayMarcus(BrimLibrary.feedbackText(score));
      if (gen !== loopGen || !loopRun) return;
      loopRun.i = 5;
      const first = loopRun.explainScore ? loopRun.explainScore.overall : score.overall;
      const overall = Math.round((first + score.overall) / 2);
      const r = BrimEngine.awardXP(eng.p, 'comm.' + loopRun.spec.id, overall);
      BrimEngine.touchStreak(eng.p, Date.now());
      eng.p.achievements = eng.p.achievements || {};
      eng.p.achievements[loopRun.spec.id] = { title: loopRun.spec.achievement, t: Date.now(), score: overall };
      eng.p.history.unshift({ t: Date.now(), activity: loopRun.spec.title + ' challenge', score: overall, xp: r.xp, summary: loopRun.spec.achievement });
      eng.p.history = eng.p.history.slice(0, 50);
      eng.p.lastFeedback = loopRun.spec.title + ' challenge: score ' + overall + '. ' + loopRun.spec.achievement + '.';
      save();
      renderStats();
      if ($('marcusPhish') && loopRun.spec.unlocks) { $('marcusPhish').disabled = false; $('marcusPhish').textContent = 'Phishing challenge'; }
      const next = loopRun.spec.unlocks ? ' Phishing is unlocked.' : '';
      await sayMarcus('Advance. Score ' + overall + ' across both tries. You earned ' + r.xp + ' XP. Achievement: ' + loopRun.spec.achievement + '.' + next);
      loopRun = null;
      if (liveWork && liveWork.kind === 'loop') liveWork = null;
      renderDots();
    }
  }
  if ($('marcusCia')) $('marcusCia').onclick = () => beginChallenge('marcus-cia');
  if ($('marcusPhish')) $('marcusPhish').onclick = () => beginChallenge('marcus-phish');

  const LEARNER_KEY = 'brimmesa.learner.marcus';
  const PROBES = [
    { id: 'cia', ask: "Don't recite the poster. Explain the CIA triad in your own words.", keys: ['confidentiality', 'integrity', 'availability'] },
    { id: 'phishing', ask: 'Explain phishing in your own words. What makes spear phishing different?', keys: ['phish', 'fake', 'link', 'spear'] },
    { id: 'network', ask: 'Last one. What does a firewall actually do? Plain words.', keys: ['filter', 'block', 'allow', 'traffic', 'network'] }
  ];
  function blankLearner() {
    return { met: false, step: 'know', pending: '', newbie: false, asked: [], domains: {}, comm: { clarity: 0, confidence: 0, n: 0 }, gaps: [], lastTopic: '', start: '' };
  }
  function loadLearner() {
    const saved = readJSON(LEARNER_KEY, null);
    if (!saved || typeof saved !== 'object') return blankLearner();
    saved.domains = saved.domains || {};
    saved.comm = saved.comm || { clarity: 0, confidence: 0, n: 0 };
    saved.gaps = saved.gaps || [];
    saved.asked = saved.asked || [];
    return saved;
  }
  function saveLearner(p) { localStorage.setItem(LEARNER_KEY, JSON.stringify(p)); }
  function levelWord(n) { return n >= 75 ? 'solid' : n >= 40 ? 'workable' : 'early'; }
  function scoreAnswer(text, keys) {
    return BrimLibrary.rubric(text, { keywords: keys, practiceKeywords: keys }, 'explain');
  }
  function noteScore(learner, id, score) {
    learner.domains[id] = score.dims.accuracy;
    const n = (learner.comm.n || 0) + 1;
    learner.comm.clarity = Math.round(((learner.comm.clarity || 0) * (n - 1) + score.dims.clarity) / n);
    learner.comm.confidence = Math.round(((learner.comm.confidence || 0) * (n - 1) + score.dims.confidence) / n);
    learner.comm.n = n;
    learner.gaps = Object.keys(learner.domains).filter(k => learner.domains[k] < 60);
    learner.lastTopic = id;
  }
  function nextProbe(learner) {
    return PROBES.find(p => learner.asked.indexOf(p.id) < 0 && !(learner.domains[p.id] >= 75)) || null;
  }
  function probeCap(learner) {
    if (learner.newbie) return 1;
    if ((learner.domains.cia || 0) >= 75) return 3;
    return 2;
  }
  function startingLine(learner) {
    const cia = learner.domains.cia == null ? 0 : learner.domains.cia;
    const phish = learner.domains.phishing == null ? 100 : learner.domains.phishing;
    if (cia < 60) {
      learner.start = 'CIA challenge';
      return 'Starting point: the CIA triad. Your explanation was ' + levelWord(cia) + '. Say challenge when you want that activity. I will not open it for you.';
    }
    if (phish < 60) {
      learner.start = 'phishing';
      return 'CIA is ' + levelWord(cia) + '. Starting point: phishing. Say teach phishing, or say quiz if you want five questions.';
    }
    learner.start = 'quiz';
    return 'You can explain this. Clarity ' + learner.comm.clarity + ', confidence ' + learner.comm.confidence + '. Starting point: a five-question Security+ quiz. Say quiz when you want it.';
  }
  function wantsAria(text) {
    return /\b(back to aria|return to aria|back to the map|talk to aria)\b/i.test(text);
  }
  function ariaSummary() {
    const recent = spokenRecent.slice(-4).map(l => (l.speaker === 'user' ? 'User' : l.speaker) + ': ' + l.text).join(' | ');
    const rolled = window.BrimGym ? BrimGym.summaryText(BrimGym.loadProfile()) : '';
    if (!rolled) return recent;
    if (!recent) return rolled;
    return (rolled + ' | ' + recent).slice(0, 500);
  }
  async function detectIntent(text) {
    const fallback = BrimLibrary.keywordIntent(text);
    const named = BrimLibrary.HOSTS.some(h => String(text).toLowerCase().indexOf(h.id) >= 0);
    if (!named || !localStorage.getItem(GEMINI_KEY) || llm.overLimit()) return fallback;
    try {
      const raw = await llm.generate([
        'Does the user want an introduction to one coach?',
        'Coaches: marcus, amara, jasmine, renee.',
        'JSON only: {"coach":"marcus|amara|jasmine|renee|none","topic":""}',
        'User: ' + String(text).slice(0, 300)
      ].join('\n'), null);
      const clean = String(raw || '').replace(/```json|```/g, '').trim();
      let j = null;
      try { j = JSON.parse(clean); } catch (e) {
        const m = clean.match(/\{[\s\S]*\}/);
        if (m) { try { j = JSON.parse(m[0]); } catch (e2) { j = null; } }
      }
      const host = j && BrimLibrary.HOSTS.find(h => h.id === String(j.coach || '').toLowerCase());
      if (!host) return fallback;
      const topic = String((j && j.topic) || (fallback && fallback.topic) || '').trim();
      return { coachId: host.id, topic: topic, place: host.place, dest: host.dest, line: host.line };
    } catch (e) { return fallback; }
  }
  function showVisit(coach) {
    const card = $('visitCard');
    if (!card) return;
    card.hidden = false;
    const img = $('visitImg');
    img.src = coach.portrait;
    img.alt = 'Portrait of ' + coach.name;
    $('visitName').textContent = coach.name;
    $('visitLine').textContent = hostSession && hostSession.topic ? 'About ' + hostSession.topic : coach.role;
    card.classList.remove('handoff-card');
    void card.offsetWidth;
    card.classList.add('handoff-card');
  }
  function experienceFor(coachId) {
    if (coachId === 'marcus') {
      const profile = loadLearner();
      if (!profile.met) return 'new';
      const nums = Object.keys(profile.domains || {}).map(k => Number(profile.domains[k]) || 0);
      const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
      return avg >= 70 ? 'experienced' : 'working';
    }
    const saved = readJSON('brimmesa.learner.' + coachId, null);
    return saved && saved.level === 'experienced' ? 'experienced' : 'beginner';
  }
  function markExperienced(coachId) {
    if (!coachId || coachId === 'marcus') return;
    const prior = readJSON('brimmesa.learner.' + coachId, {}) || {};
    prior.level = 'experienced';
    localStorage.setItem('brimmesa.learner.' + coachId, JSON.stringify(prior));
  }
  function guestOpen(coach, handoff) {
    if (hostSession) hostSession.teachStep = 'invite';
    if (window.BrimGym && coachMode(coach.id) === 'coaching') {
      const row = BrimGym.coachOf(BrimGym.loadBoard(), coach.id);
      touchCoach(coach.id, { mode: 'coaching', topic: handoff.topic || row.topic, step: row.updated ? row.step : 'explain' });
    }
    const line = BrimLibrary.methodLine(coach.id, {
      topic: handoff.topic,
      goal: handoff.goal,
      heard: handoff.userLine,
      experienced: experienceFor(coach.id) === 'experienced'
    });
    const aside = window.BrimContext ? BrimContext.aside() : '';
    if (!aside || contextAsideUsed) return line;
    contextAsideUsed = true;
    return aside + ' ' + line;
  }
  async function returnToAria() {
    const rolled = window.BrimGym ? BrimGym.loadProfile() : null;
    const topic = (hostSession && (hostSession.topic || hostSession.lastTopic)) || (rolled && rolled.topic) || '';
    const last = (hostSession && hostSession.lastExchange) || '';
    const who = hostSession ? ((cast.find(c => c.id === hostSession.coachId) || {}).name || '') : '';
    releaseWork();
    hostSession = null;
    hostLock = false;
    eng.activeCoach = null;
    syncPresenter('idle', 'aria');
    if (window.BrimMap) window.BrimMap.fit();
    if ($('visitCard')) $('visitCard').hidden = true;
    const bit = who ? 'You were with ' + who : 'Welcome back';
    const about = topic ? ' on ' + topic : '';
    const tail = last ? ' Last thing you said: ' + last + '.' : '';
    await play([{ speaker: 'aria', text: bit + about + '.' + tail + ' Where to next?' }]);
  }
  async function marcusGreet(handoff) {
    const learner = loadLearner();
    learner.lastTopic = handoff.topic || learner.lastTopic || '';
    const topic = handoff.topic ? ' Aria said this is about ' + handoff.topic + '.' : ' Aria walked you over.';
    if (learner.met) {
      saveLearner(learner);
      const cia = learner.domains.cia == null ? 'unknown' : levelWord(learner.domains.cia);
      await play([{ speaker: 'marcus', text: 'Aria already introduced you.' + topic + ' Last time CIA was ' + cia + '. We left off at ' + (learner.start || 'the CIA triad') + '. Say challenge, quiz, or teach.' }]);
      return;
    }
    if (learner.step === 'probe' && learner.pending) {
      const probe = PROBES.find(p => p.id === learner.pending);
      saveLearner(learner);
      await play([{ speaker: 'marcus', text: 'Aria sent you back. We were still on this. ' + (probe ? probe.ask : 'What do you already know?') }]);
      return;
    }
    learner.step = 'know';
    learner.met = false;
    saveLearner(learner);
    await play([{ speaker: 'marcus', text: BrimLibrary.methodLine('marcus', { topic: handoff.topic, experienced: false }) }]);
  }
  async function finishAssess(learner) {
    const line = startingLine(learner);
    learner.met = true;
    learner.step = 'done';
    saveLearner(learner);
    if (hostSession) hostSession.lastTopic = learner.start;
    await play([{ speaker: 'marcus', text: line }]);
  }
  async function assessTurn(value) {
    const learner = loadLearner();
    if (/[?]/.test(value) || /^(what|why|how|who|tell me)\b/i.test(value)) {
      await marcusSpeak(value);
      return;
    }
    if (/\bskip ahead\b/i.test(value)) {
      learner.met = true;
      learner.step = 'done';
      learner.start = 'quiz';
      if (learner.domains.cia == null) learner.domains.cia = 80;
      saveLearner(learner);
      await play([{ speaker: 'marcus', text: BrimLibrary.methodReply('marcus', value) }]);
      return;
    }
    if (learner.step === 'know') {
      const pre = scoreAnswer(value, PROBES[0].keys);
      if (pre.dims.accuracy >= 67) {
        noteScore(learner, 'cia', pre);
        learner.asked.push('cia');
      }
      learner.newbie = /\b(nothing|zero|beginner|brand new|don't know|dont know|no idea|starting over)\b/i.test(value);
      if (learner.newbie) learner.asked.push('phishing', 'network');
      const probe = nextProbe(learner);
      if (!probe) { await finishAssess(learner); return; }
      learner.step = 'probe';
      learner.pending = probe.id;
      learner.asked.push(probe.id);
      saveLearner(learner);
      await play([{ speaker: 'marcus', text: probe.ask }]);
      return;
    }
    const probe = PROBES.find(p => p.id === learner.pending) || PROBES[0];
    noteScore(learner, probe.id, scoreAnswer(value, probe.keys));
    const asked = learner.asked.filter(id => PROBES.some(p => p.id === id)).length;
    const nxt = asked < probeCap(learner) ? nextProbe(learner) : null;
    if (nxt) {
      learner.pending = nxt.id;
      learner.asked.push(nxt.id);
      saveLearner(learner);
      await play([{ speaker: 'marcus', text: 'Noted. ' + nxt.ask }]);
      return;
    }
    await finishAssess(learner);
  }
  async function marcusTurn(value) {
    const learner = loadLearner();
    if (!learner.met) { await assessTurn(value); return; }
    const t = value.toLowerCase();
    if (/\bquiz\b/.test(t)) { startQuiz(); return; }
    if (/\bphishing\b/.test(t) && /\bchallenge\b/.test(t)) {
      const spec = BrimLibrary.challenge('marcus-phish', Object.keys(eng.p.achievements || {}));
      if (!spec || spec.locked) {
        await play([{ speaker: 'marcus', text: 'Phishing stays locked until you finish the CIA challenge. Say challenge.' }]);
        return;
      }
      await beginChallenge('marcus-phish');
      return;
    }
    if (/^\s*challenge\s*$/.test(t) || /\b(start|begin|run) (the )?(cia )?challenge\b/.test(t) || t.trim() === 'cia') {
      await beginChallenge('marcus-cia');
      return;
    }
    if (coachMode('marcus') === 'challenge' && !/\b(quiz|challenge|teach|phish)\b/.test(t)) {
      learner.lastTopic = (hostSession && hostSession.topic) || value.slice(0, 80);
      saveLearner(learner);
      await play([{ speaker: 'marcus', text: 'Challenge mode. Say challenge for the CIA set, or quiz for five questions. I will not start it until you say so.' }]);
      return;
    }
    learner.lastTopic = (hostSession && hostSession.topic) || value.slice(0, 80);
    saveLearner(learner);
    await marcusSpeak(value);
  }
  function noteBody(hit) {
    return String((hit && hit.text) || '').replace(/\s*Link:\s*https?:\/\/\S+/gi, '').trim();
  }
  function timedLink(hit) {
    if (!hit || !hit.url) return '';
    if (hit.start == null || /[?&]t=/.test(hit.url)) return hit.url;
    return hit.url + (hit.url.indexOf('?') >= 0 ? '&' : '?') + 't=' + hit.start;
  }
  function scriptedFromNotes(coach, hit) {
    const spoken = BrimLibrary.methodReply(coach.id, '', { note: noteBody(hit) });
    if (hit.citeInConversation === false) return spoken;
    const link = timedLink(hit);
    const when = hit.start == null ? '' : ' at ' + BrimLibrary.fmtTime(hit.start);
    return spoken + ' Source: ' + hit.title + (link ? ' ' + link : '') + when + '.';
  }
  async function guestTurn(value) {
    const coach = cast.find(c => c.id === hostSession.coachId);
    if (!coach) return;
    if (/\bskip ahead\b/i.test(value)) {
      markExperienced(coach.id);
      if (hostSession) hostSession.teachStep = 'invite';
      await play([{ speaker: coach.id, text: BrimLibrary.methodReply(coach.id, value) }]);
      return;
    }
    const mode = coachMode(coach.id);
    if (mode === 'coaching' && coach.id === 'amara') { await amaraCoachTurn(coach, value); return; }
    if (mode === 'challenge' && coach.id === 'amara') {
      await play([{ speaker: 'amara', text: BrimGym.challengeBeat(value) }]);
      return;
    }
    const hits = lib.search(value + ' ' + (hostSession.topic || ''), { coach: coach.id, limit: 3 });
    const quiet = hits.length && hits[0].citeInConversation === false;
    const wantsLesson = hits.length && /\b(explain|teach|what is|what's|difference|how does|tell me about)\b/i.test(value);
    let text = '';
    if (localStorage.getItem(GEMINI_KEY) && !llm.overLimit()) {
      try {
        const prompt = wantsLesson
          ? BrimLibrary.retrievalPrompt(coach, value, hits)
          : [
            'You are ' + coach.name + '. Personality: ' + coach.personality,
            coach.styleNote ? 'Style note: ' + coach.styleNote : '',
            'Shared method when you are teaching: welcome, explain, demonstrate, invite, coach, encourage.',
            'Teach what the skill is, why a real person needs it, when they use it, and how. One example from their words when they gave you any. Natural transition, then the invite.',
            'Answer the question they actually asked. Do not substitute a different topic.',
            'Do not invent weather, a date, a holiday, or a news event.',
            window.BrimContext ? BrimContext.prompt() : '',
            'Beginners get the explanation and one example. Experienced people may skip ahead.',
            'Not every turn is a lesson. Answer questions, humor, and tangents in your own voice.',
            'Never demand an exercise before you have explained it.',
            'Aria introduced this person. Goal: ' + (hostSession.goal || 'none') + '. Topic: ' + (hostSession.topic || 'none') + '.',
            'Preferred speaking style: ' + (window.BrimGym ? BrimGym.loadProfile().preferredStyle : 'direct') + '.',
            mode === 'freetalk' ? 'Mode: free talk. Answer in your own voice. Do not assign the next lesson step.' : '',
            'Aria context: ' + (hostSession.ariaSummary || 'none'),
            'Reply in one to three spoken sentences. No markdown. Write the brand as Brimmesa.',
            'They said: ' + value.slice(0, 400)
          ].filter(Boolean).join('\n');
        const got = await llm.generate(prompt, null);
        const clean = String(got || '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 460);
        if (clean) text = quiet ? scrubSource(clean, hits[0] || {}) : clean;
      } catch (e) {}
    }
    if (!text && wantsLesson) text = scriptedFromNotes(coach, hits[0]);
    if (!text) text = BrimLibrary.methodReply(coach.id, value);
    if (hostSession) hostSession.teachStep = mode === 'freetalk' ? 'invite' : 'coach';
    await play([{ speaker: coach.id, text: text }]);
  }
  async function amaraCoachTurn(coach, value) {
    const board = BrimGym.loadBoard();
    const state = BrimGym.coachOf(board, 'amara');
    const beat = BrimGym.amaraBeat(state, value, {
      topic: (hostSession && hostSession.topic) || state.topic,
      now: Date.now(),
      explain: BrimLibrary.methodLine('amara', {
        topic: (hostSession && hostSession.topic) || '',
        goal: (hostSession && hostSession.goal) || '',
        heard: value,
        experienced: experienceFor('amara') === 'experienced'
      }),
      score: text => BrimLibrary.rubric(text, { keywords: ['because', 'reason', 'claim'], practiceKeywords: ['because'] }, 'explain')
    });
    BrimGym.saveBoard(BrimGym.putCoach(board, 'amara', beat.state));
    let profile = BrimGym.loadProfile();
    if (beat.lesson) profile = BrimGym.applyLesson(profile, beat.lesson, { xp: eng.p.xp, streak: eng.p.streak });
    profile = BrimGym.noteProgress(profile, 'amara', beat.state);
    profile.xp = eng.p.xp || 0;
    profile.streak = eng.p.streak || 0;
    BrimGym.saveProfile(profile);
    if (hostSession) hostSession.teachStep = beat.state.step;
    await play([{ speaker: coach.id, text: beat.say }]);
  }
  async function coachTurn(value) {
    if (hostSession) hostSession.lastExchange = String(value || '').slice(0, 160);
    const factual = await factualReply(value);
    if (factual && hostSession) { await play([{ speaker: hostSession.coachId, text: factual }]); return; }
    if (hostSession && hostSession.coachId === 'marcus') return marcusTurn(value);
    return guestTurn(value);
  }
  const INTRO = {
    amara: [
      { speaker: 'aria', text: 'This is Amara, at Mindset and Purpose.' },
      { speaker: 'amara', text: "I'm glad you walked over." }
    ],
    marcus: [
      { speaker: 'aria', text: 'This is Marcus, at the Cybersecurity Academy.' },
      { speaker: 'marcus', text: 'You made it. We will start clean.' }
    ],
    jasmine: [
      { speaker: 'aria', text: 'This is Jasmine, in Relationships and Dating.' },
      { speaker: 'jasmine', text: "Hey. Come closer, I'm right here." }
    ],
    renee: [
      { speaker: 'aria', text: 'This is Renee, for Lifestyle and Social Skills.' },
      { speaker: 'renee', text: "I'm here. Let's see who else is in the room." }
    ]
  };
  function hideTalk() {
    const box = $('talkFace');
    if (box) box.hidden = true;
    stopPulse();
  }
  async function showTalk(coach, line) {
    const box = $('talkFace');
    if (!box || !coach) return;
    box.hidden = false;
    box.dataset.coach = coach.id;
    box.dataset.mouth = coach.id === 'amara' ? 'warp' : 'pulse';
    box.dataset.speaking = '0';
    box.style.setProperty('--jaw', '0');
    const img = $('talkImg');
    if (img) {
      img.src = coach.portrait;
      img.alt = 'Portrait of ' + coach.name;
      img.style.visibility = '';
    }
    if ($('talkName')) $('talkName').textContent = coach.name;
    if ($('talkLine')) $('talkLine').textContent = line || coach.role || '';
    syncMode(coach.id);
    if (coach.id !== 'amara') {
      if ($('talkMount')) $('talkMount').replaceChildren();
      return;
    }
    const api = await Promise.race([
      ensureFace($('talkMount')),
      new Promise(resolve => setTimeout(() => resolve(null), 1600))
    ]);
    if (api && img) img.style.visibility = 'hidden';
  }
  function syncMode(id) {
    const sel = $('coachMode');
    const pick = $('modePick');
    if (!sel || !window.BrimGym) return;
    if (pick) pick.hidden = !id || id === 'aria';
    sel.value = coachMode(id);
    sel.onchange = () => {
      const board = BrimGym.loadBoard();
      const row = BrimGym.coachOf(board, id);
      row.mode = sel.value;
      BrimGym.saveBoard(BrimGym.putCoach(board, id, row));
    };
  }
  function renderProfile() {
    const box = $('profileReview');
    if (!box || !window.BrimGym) return;
    const p = BrimGym.loadProfile();
    const skills = (p.skills || []).map(s => (s.name || s.id || 'skill') + (s.level != null ? ' ' + s.level : '')).join('; ');
    const lessons = (p.lessons || []).map(l => (l.title || 'Lesson') + ' (' + (l.step || l.status || '') + ')').join('; ');
    const rows = [
      ['Lessons', lessons || 'None yet'],
      ['Skills', skills || 'None saved'],
      ['Strengths', (p.strengths || []).join('; ') || 'None yet'],
      ['Working on', (p.weaknesses || []).join('; ') || 'None yet'],
      ['XP', String(p.xp || 0)],
      ['Streak', String(p.streak || 0) + ' day'],
      ['Objectives', (p.objectives || []).join('; ') || 'None yet'],
      ['Style', p.preferredStyle || 'direct'],
      ['Topic', p.topic || 'None yet']
    ];
    box.replaceChildren();
    rows.forEach(pair => {
      const row = el('div', 'profile-row');
      row.append(el('strong', null, pair[0]), el('span', null, pair[1]));
      box.append(row);
    });
    if ($('profileStyle')) $('profileStyle').value = p.preferredStyle || 'direct';
  }
  function profileSkills() {
    return Object.keys(eng.p.mastery || {}).map(k => ({
      id: k,
      name: eng.skillTitle(k),
      level: (eng.p.mastery[k] && eng.p.mastery[k].best) || 0
    }));
  }
  function meetAria() {
    const aria = cast.find(c => c.id === 'aria');
    if (!aria) return;
    const text = ($('ariaLine') && $('ariaLine').textContent) || "I'm Aria. Pick a glowing stop.";
    showTalk(aria, text);
  }
  window.BrimMeet = meetAria;
  async function escort(coach, dest) {
    hideTalk();
    let trip = { walked: false, skipped: false };
    if (window.BrimWalk && coach) {
      try {
        const ready = await BrimWalk.prepare(coach.id);
        if (ready) {
          const walked = await BrimWalk.play({ coachId: coach.id, dest: dest || null });
          trip = { walked: !!walked, skipped: !!(BrimWalk.wasSkipped && BrimWalk.wasSkipped()) };
        }
      } catch (e) {
        trip.failed = true;
        if (BrimWalk.fail) BrimWalk.fail();
        else if (BrimWalk.cancel) BrimWalk.cancel();
      }
    }
    if (trip.failed && dest && window.BrimMap && window.BrimWorld && BrimWorld.settleAfterError) {
      const spot = BrimWorld.settleAfterError(BrimWalk.walkerPos ? BrimWalk.walkerPos() : null, dest);
      if (BrimMap.look) BrimMap.look(spot.x, spot.y, spot.scale, { ms: spot.ms });
    } else if (!trip.walked && dest && window.BrimMap) window.BrimMap.focus(dest.x, dest.y);
    if (INTRO[coach.id]) await play(INTRO[coach.id]);
    await showTalk(coach);
    return trip;
  }
  async function activateCoach(id) {
    const coach = cast.find(c => c.id === id);
    if (!coach) return;
    unlockAudio();
    greeted = true;
    openerHeard = true;
    if ($('hearAria')) $('hearAria').hidden = true;
    releaseWork();
    if (id === 'aria') {
      hostSession = null;
      hostLock = false;
      eng.activeCoach = null;
      const dest = destinations.find(d => d.id === 'central');
      if (dest) selectDestination(dest);
      showHome();
      if (window.BrimMap) window.BrimMap.fit();
      if ($('visitCard')) $('visitCard').hidden = true;
      openCentral();
      return;
    }
    const host = BrimLibrary.HOSTS.find(h => h.id === id);
    const dest = host ? destinations.find(d => d.id === host.dest) : null;
    eng.activeCoach = id;
    hostLock = true;
    if (dest) selectDestination(dest);
    showHome();
    bindCoach(id, host ? host.place : coach.role, { quiet: true });
    await escort(coach, dest);
    showVisit(coach);
    hostLock = false;
    if (!hostSession || hostSession.coachId !== id) return;
    if (id === 'marcus') await marcusGreet(hostSession);
    else await play([{ speaker: id, text: guestOpen(coach, hostSession) }]);
  }
  async function beginHandoff(intent, userText) {
    const coach = cast.find(c => c.id === intent.coachId);
    if (!coach) return;
    releaseWork();
    eng.activeCoach = coach.id;
    const dest = destinations.find(d => d.id === intent.dest);
    if (dest) selectDestination(dest);
    hostSession = {
      coachId: intent.coachId,
      topic: intent.topic || '',
      goal: (eng.p.goal || '').trim(),
      ariaSummary: ariaSummary(),
      userLine: userText,
      lastExchange: '',
      lastTopic: ''
    };
    hostLock = true;
    showHome();
    await escort(coach, dest);
    showVisit(coach);
    hostLock = false;
    if (!hostSession || hostSession.coachId !== coach.id) return;
    if (coach.id === 'marcus') await marcusGreet(hostSession);
    else await play([{ speaker: coach.id, text: guestOpen(coach, hostSession) }]);
  }
  async function loadAdminLibrary() {
    try {
      const res = await fetch('data/library/manifest.json');
      if (!res.ok) return;
      const man = await res.json();
      for (const path of man.files || []) {
        try {
          const docRes = await fetch(path);
          if (!docRes.ok) continue;
          const doc = await docRes.json();
          (doc.items || []).forEach(item => { if (item && item.title) lib.importAdmin(item); });
        } catch (e) {}
      }
    } catch (e) {}
  }
  if ($('backAria')) $('backAria').onclick = () => { if (hostSession) returnToAria(); };
  if ($('profileForm')) $('profileForm').onsubmit = e => {
    e.preventDefault();
    if (!window.BrimGym) return;
    const next = BrimGym.editProfile(BrimGym.loadProfile(), {
      preferredStyle: $('profileStyle') ? $('profileStyle').value : 'direct',
      objective: $('profileObjective') ? $('profileObjective').value : '',
      strength: $('profileStrength') ? $('profileStrength').value : '',
      weakness: $('profileWeakness') ? $('profileWeakness').value : '',
      xp: eng.p.xp || 0,
      streak: eng.p.streak || 0,
      skills: profileSkills()
    });
    BrimGym.saveProfile(next);
    if ($('profileObjective')) $('profileObjective').value = '';
    if ($('profileStrength')) $('profileStrength').value = '';
    if ($('profileWeakness')) $('profileWeakness').value = '';
    if ($('profileDelete')) { $('profileDelete').dataset.armed = ''; $('profileDelete').textContent = 'Delete learner profile'; }
    renderProfile();
  };
  if ($('profileDelete')) $('profileDelete').onclick = () => {
    if (!window.BrimGym) return;
    if ($('profileDelete').dataset.armed !== '1') {
      $('profileDelete').dataset.armed = '1';
      $('profileDelete').textContent = 'Confirm delete';
      return;
    }
    BrimGym.deleteProfile();
    $('profileDelete').dataset.armed = '';
    $('profileDelete').textContent = 'Delete learner profile';
    renderProfile();
  };
  if ($('coachStateDelete')) $('coachStateDelete').onclick = () => {
    if (!window.BrimGym) return;
    if ($('coachStateDelete').dataset.armed !== '1') {
      $('coachStateDelete').dataset.armed = '1';
      $('coachStateDelete').textContent = 'Confirm clear';
      return;
    }
    BrimGym.deleteBoard();
    $('coachStateDelete').dataset.armed = '';
    $('coachStateDelete').textContent = 'Clear coaching steps';
    renderProfile();
  };

  setupMap();
  showWorld('map');

  buildSidebar();
  buildTeam();
  buildTimeline();
  idleCaption();
  renderStats();
  applyRoute();
  await loadAdminLibrary();
  document.body.dataset.ready = '1';
  if (window.BrimContext) {
    eng.liveBrief = BrimContext.prompt();
    BrimContext.ensure({ news: false }).then(snap => {
      eng.liveBrief = BrimContext.prompt();
      paintContext(snap);
    }).catch(() => {});
  }
  prepareOpener();
  if (window.BrimWalk && (document.body.dataset.view || 'map') === 'map') BrimWalk.entrance();
  if ($('talkMap')) $('talkMap').onclick = () => { hideTalk(); if (window.BrimMap) BrimMap.fit(); };
})().catch(err => {
  const note = document.getElementById('note');
  if (note) note.textContent = 'The coach could not load. Reload the page.';
  console.error(err);
});
