// Speech helpers: brand pronunciation and Gemini TTS requests. No DOM. No key logging.
(function (root) {
  const TTS_MODEL = 'gemini-3.8-flash-lite-tts';
  const TTS_DAILY = 40;
  const SAMPLE_RATE = 24000;
  const BRAND = /\bbrimmesa\b/gi;

  function pronounce(text, mode) {
    const spoken = mode === 'phonetic' ? 'Brih-meh-sah' : 'Brimmesa';
    return String(text || '').replace(BRAND, spoken);
  }

  function browserSpells(voice) {
    const name = (voice && voice.name) || '';
    return !/google|natural|neural/i.test(name);
  }

  function spokenText(text, engine) {
    return pronounce(text, engine === 'basic' ? 'phonetic' : 'word');
  }

  function sentences(text) {
    const parts = String(text || '').match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [];
    return parts.map(s => s.trim()).filter(Boolean);
  }

  function styleFor(hint, emotion) {
    const mood = { smile: 'warm smile', laugh: 'light laugh', concern: 'gentle concern', surprise: 'a brief surprise' };
    return [hint, mood[emotion] || ''].filter(Boolean).join(', ').slice(0, 80);
  }

  function ttsBody(text, voice, style) {
    const content = { type: 'text', text: String(text || '') };
    if (style) content.annotations = [{ type: 'speech_metadata', style: style }];
    return {
      model: TTS_MODEL,
      input: [{ type: 'user_input', content: [content] }],
      response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: SAMPLE_RATE },
      generation_config: { speech_config: [{ voice: voice || 'Sulafat' }] }
    };
  }

  function extractAudio(json) {
    const audio = json && (json.output_audio || json.outputAudio);
    if (audio && audio.data) return { b64: audio.data, mime: audio.mime_type || audio.mimeType || 'audio/wav' };
    const parts = ((((json || {}).candidates || [])[0] || {}).content || {}).parts || [];
    const part = parts.find(p => p && p.inlineData && p.inlineData.data);
    if (!part) return null;
    return { b64: part.inlineData.data, mime: part.inlineData.mimeType || 'audio/wav' };
  }

  function b64ToBytes(b64) {
    const clean = String(b64 || '').replace(/\s/g, '');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function readStr(bytes, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
  }

  function parseWav(bytes) {
    if (!bytes || bytes.length < 44) return null;
    if (readStr(bytes, 0, 4) !== 'RIFF' || readStr(bytes, 8, 4) !== 'WAVE') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12, rate = SAMPLE_RATE, data = null;
    while (offset + 8 <= bytes.length) {
      const id = readStr(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      if (id === 'fmt ' && offset + 16 <= bytes.length) rate = view.getUint32(offset + 12, true) || rate;
      if (id === 'data') {
        data = bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + size));
        break;
      }
      offset += 8 + size + (size % 2);
    }
    return data ? { sampleRate: rate, pcm: data } : null;
  }

  function encodeWav(pcm, sampleRate) {
    const rate = sampleRate || SAMPLE_RATE;
    const data = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm || 0);
    const out = new Uint8Array(44 + data.length);
    const view = new DataView(out.buffer);
    const write = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
    write(0, 'RIFF');
    view.setUint32(4, 36 + data.length, true);
    write(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, data.length, true);
    out.set(data, 44);
    return out;
  }

  function fitWords(text, durationMs) {
    const words = String(text || '').match(/[A-Za-z0-9']+/g) || [];
    const dur = Math.max(120, Math.round(durationMs || 0));
    if (!words.length) return { words: [' '], wtimes: [0], wdurations: [dur] };
    const weights = words.map(w => Math.max(1, w.length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = 0;
    const wtimes = [];
    const wdurations = [];
    weights.forEach((w, i) => {
      const slice = i === weights.length - 1 ? Math.max(40, dur - t) : Math.max(40, Math.round(dur * w / total));
      wtimes.push(t);
      wdurations.push(slice);
      t += slice;
    });
    return { words, wtimes, wdurations };
  }

  function dayStamp(now) {
    const d = new Date(typeof now === 'function' ? now() : Date.now());
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function createSpeaker(opts) {
    opts = opts || {};
    const limit = opts.dailyLimit || TTS_DAILY;
    function usageNow() {
      let u = { day: '', count: 0 };
      try { u = (opts.readUsage && opts.readUsage()) || u; } catch (e) { u = { day: '', count: 0 }; }
      const day = dayStamp(opts.now);
      return { day, count: u.day === day ? (Number(u.count) || 0) : 0 };
    }
    function bump() {
      const u = usageNow();
      try { opts.writeUsage && opts.writeUsage({ day: u.day, count: u.count + 1 }); } catch (e) {}
    }
    return {
      model: TTS_MODEL,
      dailyLimit: limit,
      usageNow,
      async synthesize(text, voice, style) {
        const spoken = spokenText(text, 'gemini');
        if (!spoken) return { blocked: 'empty' };
        const cacheKey = [TTS_MODEL, voice || 'Sulafat', style || '', spoken].join('\n');
        try {
          const hit = opts.cacheGet && await opts.cacheGet(cacheKey);
          if (hit && hit.length) return { bytes: hit, mime: 'audio/wav', cached: true, spoken };
        } catch (e) {}
        const key = opts.getKey ? opts.getKey() : '';
        if (!key) return { blocked: 'nokey', spoken };
        if (usageNow().count >= limit) return { blocked: 'limit', spoken };
        const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
        if (!fetchFn) return { blocked: 'error', spoken };
        const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
        let res;
        try {
          res = await fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(ttsBody(spoken, voice, style))
          });
        } catch (e) {
          return { blocked: 'offline', spoken };
        }
        if (!res || !res.ok) return { blocked: res && res.status === 429 ? 'rate' : 'error', status: res && res.status, spoken };
        bump();
        let audio = null;
        try { audio = extractAudio(await res.json()); } catch (e) { audio = null; }
        if (!audio || !audio.b64) return { blocked: 'error', spoken };
        let bytes = b64ToBytes(audio.b64);
        if (!parseWav(bytes)) bytes = encodeWav(bytes, SAMPLE_RATE);
        try { opts.cacheSet && await opts.cacheSet(cacheKey, bytes); } catch (e) {}
        return { bytes, mime: audio.mime || 'audio/wav', cached: false, spoken };
      }
    };
  }

  const EL_MODEL = 'eleven_flash_v2_5';
  const EL_VOICES = {
    amara: { voice_id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda' },
    jasmine: { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica' },
    renee: { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
    marcus: { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel' }
  };
  const VISEME = {
    a: 'aa', e: 'E', i: 'I', o: 'O', u: 'U',
    p: 'PP', b: 'PP', m: 'PP', f: 'FF', v: 'FF',
    d: 'DD', t: 'DD', k: 'kk', c: 'kk', g: 'kk', q: 'kk',
    s: 'SS', z: 'SS', n: 'nn', l: 'nn', r: 'RR', w: 'U', y: 'I',
    j: 'CH', h: 'aa'
  };

  function charViseme(ch, next) {
    const c = String(ch || '').toLowerCase();
    const n = String(next || '').toLowerCase();
    if (c === 't' && n === 'h') return 'TH';
    if ((c === 'c' || c === 's') && n === 'h') return 'CH';
    if (!/[a-z]/.test(c)) return '';
    return VISEME[c] || '';
  }

  function alignmentPlan(alignment) {
    const chars = (alignment && alignment.characters) || [];
    const starts = (alignment && alignment.character_start_times_seconds) || [];
    const ends = (alignment && alignment.character_end_times_seconds) || [];
    const visemes = [];
    const vtimes = [];
    const vdurations = [];
    const words = [];
    const wtimes = [];
    const wdurations = [];
    let word = '';
    let wordStart = 0;
    let wordEnd = 0;
    function flushWord() {
      if (!word) return;
      words.push(word);
      wtimes.push(wordStart);
      wdurations.push(Math.max(40, wordEnd - wordStart));
      word = '';
    }
    for (let i = 0; i < chars.length; i++) {
      const ch = String(chars[i] || '');
      const start = Math.round((Number(starts[i]) || 0) * 1000);
      const end = Math.max(start + 30, Math.round((Number(ends[i]) || 0) * 1000));
      if (!/[A-Za-z0-9']/.test(ch)) { flushWord(); continue; }
      if (!word) wordStart = start;
      word += ch;
      wordEnd = end;
      const digraph = (ch === 't' || ch === 'T' || ch === 'c' || ch === 'C' || ch === 's' || ch === 'S') && /h/i.test(chars[i + 1] || '');
      const name = charViseme(ch, chars[i + 1]);
      if (name) {
        const stop = digraph ? Math.max(end, Math.round((Number(ends[i + 1]) || 0) * 1000)) : end;
        const last = visemes.length - 1;
        if (last >= 0 && visemes[last] === name && vtimes[last] + vdurations[last] >= start - 20) {
          vdurations[last] = Math.max(vdurations[last], stop - vtimes[last]);
        } else {
          visemes.push(name);
          vtimes.push(start);
          vdurations.push(Math.max(30, stop - start));
        }
      }
      if (digraph) {
        word += chars[i + 1];
        wordEnd = Math.max(wordEnd, Math.round((Number(ends[i + 1]) || 0) * 1000));
        i++;
      }
    }
    flushWord();
    if (!visemes.length) {
      visemes.push('aa');
      vtimes.push(0);
      vdurations.push(120);
    }
    return { words, wtimes, wdurations, visemes, vtimes, vdurations };
  }

  function pickVoice(voices, characterId) {
    const want = EL_VOICES[characterId] || EL_VOICES.amara;
    const list = voices || [];
    const idOf = v => v && (v.voice_id || v.id);
    const found = list.find(v => idOf(v) === want.voice_id)
      || list.find(v => String(v.name || '').toLowerCase() === want.name.toLowerCase());
    if (found) return { voice_id: idOf(found), name: found.name || want.name, labels: found.labels || {}, category: found.category || '' };
    const female = characterId !== 'marcus';
    const gendered = list.find(v => String((v.labels && v.labels.gender) || '').toLowerCase() === (female ? 'female' : 'male'));
    const row = gendered || list[0];
    if (row) return { voice_id: idOf(row), name: row.name || want.name, labels: row.labels || {}, category: row.category || '' };
    return { voice_id: want.voice_id, name: want.name, labels: {}, category: 'premade' };
  }

  function createEleven(opts) {
    opts = opts || {};
    const base = 'https://api.elevenlabs.io';
    function key() { return opts.getKey ? String(opts.getKey() || '') : ''; }
    async function call(path, options) {
      const k = key();
      if (!k) return { blocked: 'nokey' };
      const fetchFn = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
      if (!fetchFn) return { blocked: 'error' };
      const headers = Object.assign({ 'xi-api-key': k }, (options && options.headers) || {});
      let res;
      try {
        res = await fetchFn(base + path, Object.assign({}, options || {}, { headers }));
      } catch (e) {
        return { blocked: 'offline' };
      }
      return { res };
    }
    return {
      model: EL_MODEL,
      defaults: EL_VOICES,
      async listVoices() {
        const got = await call('/v1/voices?show_legacy=true', { method: 'GET' });
        if (got.blocked) return Object.assign({ voices: [] }, got);
        if (!got.res || !got.res.ok) return { blocked: got.res && got.res.status === 429 ? 'rate' : 'error', status: got.res && got.res.status, voices: [] };
        let json = {};
        try { json = await got.res.json(); } catch (e) { json = {}; }
        const voices = (json.voices || []).map(v => ({
          voice_id: v.voice_id,
          name: v.name || 'Voice',
          category: v.category || '',
          labels: v.labels || {}
        })).filter(v => v.voice_id);
        return { voices };
      },
      async subscription() {
        const got = await call('/v1/user/subscription', { method: 'GET' });
        if (got.blocked) return got;
        if (!got.res || !got.res.ok) {
          return { blocked: got.res && got.res.status === 401 ? 'badkey' : got.res && got.res.status === 429 ? 'rate' : 'error', status: got.res && got.res.status };
        }
        let json = {};
        try { json = await got.res.json(); } catch (e) { return { blocked: 'error' }; }
        return {
          tier: json.tier || '',
          character_count: Number(json.character_count) || 0,
          character_limit: Number(json.character_limit) || 0,
          status: json.status || ''
        };
      },
      async synthesize(text, voiceId) {
        const spoken = spokenText(text, 'gemini');
        if (!spoken) return { blocked: 'empty' };
        const voice = voiceId || EL_VOICES.amara.voice_id;
        const cacheKey = ['eleven', EL_MODEL, voice, spoken].join('\n');
        try {
          const hit = opts.cacheGet && await opts.cacheGet(cacheKey);
          if (hit && hit.bytes && hit.bytes.length) {
            return { bytes: hit.bytes, mime: hit.mime || 'audio/mpeg', plan: hit.plan, cached: true, spoken, provider: 'eleven' };
          }
        } catch (e) {}
        if (!key()) return { blocked: 'nokey', spoken };
        let sub = null;
        try { sub = opts.readUsage && opts.readUsage(); } catch (e) { sub = null; }
        if (sub && sub.character_limit && sub.character_count >= sub.character_limit) return { blocked: 'limit', spoken };
        const got = await call('/v1/text-to-speech/' + encodeURIComponent(voice) + '/with-timestamps?output_format=mp3_22050_32', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            text: spoken,
            model_id: EL_MODEL,
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: false }
          })
        });
        if (got.blocked) return Object.assign({ spoken }, got);
        const res = got.res;
        if (!res || !res.ok) return { blocked: res && res.status === 429 ? 'rate' : 'error', status: res && res.status, spoken };
        let json = null;
        try { json = await res.json(); } catch (e) { json = null; }
        if (!json || !json.audio_base64) return { blocked: 'error', spoken };
        const bytes = b64ToBytes(json.audio_base64);
        const plan = alignmentPlan(json.alignment || json.normalized_alignment);
        try { opts.cacheSet && await opts.cacheSet(cacheKey, { bytes, mime: 'audio/mpeg', plan }); } catch (e) {}
        try {
          if (opts.writeUsage) {
            opts.writeUsage({
              tier: sub && sub.tier || '',
              character_count: ((sub && Number(sub.character_count)) || 0) + spoken.length,
              character_limit: (sub && Number(sub.character_limit)) || 0
            });
          }
        } catch (e) {}
        return { bytes, mime: 'audio/mpeg', plan, cached: false, spoken, provider: 'eleven' };
      }
    };
  }

  const api = {
    TTS_MODEL, TTS_DAILY, SAMPLE_RATE, pronounce, browserSpells, spokenText, sentences,
    styleFor, ttsBody, extractAudio, b64ToBytes, parseWav, encodeWav, fitWords, dayStamp, createSpeaker,
    EL_MODEL, EL_VOICES, alignmentPlan, pickVoice, createEleven
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BrimSpeech = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
