// Microphone energy and SpeechRecognition restart rules. No network.
(function (root) {
  const MIC_CONSTRAINTS = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  };

  function rmsFromTimeDomain(bytes) {
    const n = bytes && bytes.length ? bytes.length : 0;
    if (!n) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = (bytes[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / n);
  }

  function vadStep(state, rms, now, opts) {
    const o = opts || {};
    const threshold = o.threshold == null ? 0.045 : o.threshold;
    const hold = o.holdMs == null ? 180 : o.holdMs;
    const release = o.releaseMs == null ? 280 : o.releaseMs;
    const s = state || { hotSince: 0, speaking: false, coolSince: 0 };
    const t = Number(now) || 0;
    if (rms >= threshold) {
      if (!s.hotSince) s.hotSince = t;
      s.coolSince = 0;
      if (!s.speaking && t - s.hotSince >= hold) s.speaking = true;
    } else {
      s.hotSince = 0;
      if (s.speaking) {
        if (!s.coolSince) s.coolSince = t;
        if (t - s.coolSince >= release) { s.speaking = false; s.coolSince = 0; }
      }
    }
    return s;
  }

  // A second getUserMedia stream steals the mic from SpeechRecognition on Android.
  function allowEnergyStream(ua, handsFree) {
    if (!handsFree) return false;
    const u = String(ua || '');
    if (/Android|iPhone|iPad|Mobile/i.test(u)) return false;
    return true;
  }

  function isEcho(heard, spoken) {
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const a = norm(heard);
    const b = norm(spoken);
    if (!a || !b || a.length < 12) return false;
    return b.indexOf(a) >= 0 || a.indexOf(b) >= 0;
  }

  // Android Chrome often ends recognition on its own. Restart unless the
  // listener was blocked, we aborted on purpose, or the restarts are spinning.
  function recognitionRestart(error, state) {
    const s = state || {};
    const err = String(error || '');
    if (err === 'not-allowed' || err === 'service-not-allowed') return { restart: false, giveUp: true, delay: 0, reason: 'blocked' };
    if (err === 'aborted' && s.intentional) return { restart: false, giveUp: false, delay: 0, reason: 'intentional' };
    if ((s.restarts || 0) >= 8) return { restart: false, giveUp: true, delay: 0, reason: 'restart-cap' };
    const delay = err === 'no-speech' ? 300 : err === 'network' ? 600 : 200;
    return { restart: true, giveUp: false, delay: delay, reason: err || 'end' };
  }

  const api = { MIC_CONSTRAINTS, rmsFromTimeDomain, vadStep, isEcho, recognitionRestart, allowEnergyStream };
  if (typeof module !== 'undefined') module.exports = api;
  else root.BrimVad = api;
})(typeof window !== 'undefined' ? window : globalThis);
