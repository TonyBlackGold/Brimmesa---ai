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

  const api = {
    TTS_MODEL, TTS_DAILY, SAMPLE_RATE, pronounce, browserSpells, spokenText, sentences,
    styleFor, ttsBody, extractAudio, b64ToBytes, parseWav, encodeWav, fitWords, dayStamp, createSpeaker
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BrimSpeech = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
