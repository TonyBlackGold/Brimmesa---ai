// Browser shell: loads JSON content, speech in/out, persistence. Logic lives in engine.js.
(async function () {
  const KEY = 'brimmesa.profile.v1', $ = id => document.getElementById(id);
  const worlds = await (await fetch('data/worlds.json')).json();
  const content = {};
  for (const w of worlds.worlds) for (const a of w.activities) content[a.id] = await (await fetch(a.file)).json();
  const chars = { coach: { name: worlds.coach.name, voice: worlds.coach.voice, color: '#2f5d3a' }, user: { name: 'You', color: '#c9a24a' } };
  const palette = ['#8a4fbf', '#b5533c', '#2c6e91', '#555'];
  Object.values(content).forEach(c => (c.characters || []).forEach((ch, i) => chars[ch.id] = { ...ch, color: palette[(ch.voice.index || i) % palette.length] }));

  const profile = JSON.parse(localStorage.getItem(KEY) || 'null') || BrimEngine.newProfile();
  const eng = new BrimEngine.Engine({ worlds, content, profile });
  const save = () => { localStorage.setItem(KEY, JSON.stringify(eng.p)); stats(); };
  function stats() { const p = eng.p; $('stats').innerHTML = `<span>⭐ Lv ${BrimEngine.level(p.xp)}</span><span>${p.xp} XP</span><span>🔥 ${p.streak}d</span>`; $('drive').checked = !!p.driving; }

  // ---- speech output: distinct voice per character; pitch/rate fallback when the device has only one voice
  const synth = window.speechSynthesis; let voices = [], unlocked = false;
  const loadVoices = () => {
    if (!synth) return;
    const all = synth.getVoices().filter(v => /^en/i.test(v.lang));
    // Prefer US English first, then other English; keep distinct names (Android often lists duplicates per network/local)
    const seen = new Set(); voices = all.sort((x, y) => (/US/i.test(y.lang) - /US/i.test(x.lang)) || (y.localService - x.localService))
      .filter(v => !seen.has(v.name) && seen.add(v.name));
  };
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; setTimeout(loadVoices, 500); setTimeout(loadVoices, 2000); }
  const castOrder = ['coach', 'jasmine', 'renee', 'marcus'];
  function voiceFor(id, cfg) {
    if (!voices.length) return null;
    const pref = (cfg.prefer || []).map(s => voices.find(v => v.name.includes(s))).find(Boolean);
    if (pref && id === 'coach') return pref;
    const i = Math.max(0, castOrder.indexOf(id)); return voices[i % voices.length];
  }
  // Browsers (esp. Android Chrome) only allow audio after a user tap: speak a silent utterance inside the tap handler.
  function unlockAudio() {
    if (!synth || unlocked) return; unlocked = true;
    try { synth.cancel(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); synth.resume(); } catch (e) {}
  }
  // Speak sentence chunks (Chrome can stall on long utterances) with a timeout in case onend never fires on Android.
  function speakChunk(text, voice, pitch, rate) {
    return new Promise(res => {
      const u = new SpeechSynthesisUtterance(text); if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
      u.pitch = pitch; u.rate = rate; let done = false; const fin = () => { if (!done) { done = true; clearTimeout(t); res(); } };
      const t = setTimeout(fin, 1500 + text.length * 90 / rate); u.onend = u.onerror = fin; synth.speak(u);
    });
  }
  async function speak(line) {
    if (!synth) return;
    const cfg = (chars[line.speaker] || chars.coach).voice || {};
    const v = voiceFor(line.speaker, cfg);
    let pitch = cfg.pitch || 1, rate = (cfg.rate || 1) * (eng.p.driving ? 1.05 : 1);
    if (voices.length < 2 && line.speaker !== 'coach') pitch = Math.min(2, Math.max(0.1, 1 + (pitch - 1) * 1.8)); // exaggerate to tell characters apart with one voice
    for (const part of line.text.match(/[^.!?]+[.!?]*/g) || [line.text]) { if (stopSpeaking) break; await speakChunk(part.trim(), v, pitch, rate); }
  }
  let stopSpeaking = false;
  function show(line) {
    const c = chars[line.speaker] || chars.coach, d = document.createElement('div');
    d.className = 'l ' + line.speaker;
    d.innerHTML = `<div class="av" style="background:${c.color}">${c.name[0]}</div><div class="t"><small>${c.name}</small></div>`;
    d.querySelector('.t').append(line.text); $('log').append(d); $('log').scrollTop = 1e9;
  }
  let busy = false, playId = 0;
  async function play(lines) {
    const id = ++playId; busy = true; stopSpeaking = false; stopListening();
    for (const l of lines) { show(l); if (id !== playId) return; await speak(l); if (id !== playId) return; }
    busy = false; save(); renderActs();
    if ($('auto').checked && rec && lines.length) setTimeout(listen, 250);
  }
  async function send(text) { if (!text.trim()) return; unlockAudio(); interrupt(); show({ speaker: 'user', text }); play(await eng.handle(text)); }
  function interrupt() { stopSpeaking = true; playId++; busy = false; if (synth) synth.cancel(); }

  // ---- speech input (Web Speech API; needs HTTPS or localhost). Audio is never stored.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null, listening = false, gotResult = false, misses = 0;
  if (SR && window.isSecureContext) {
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
    rec.onresult = e => { gotResult = true; misses = 0; send(e.results[e.results.length - 1][0].transcript); };
    rec.onend = () => {
      listening = false; $('mic').classList.remove('on'); $('mic').textContent = '🎤 Tap to talk';
      // Hands-free: Android ends recognition after a few seconds of silence, so restart it (gives up after ~6 silent tries).
      if (!gotResult && !busy && $('auto').checked && misses < 6 && document.visibilityState === 'visible') { misses++; setTimeout(listen, 300); }
    };
    rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { misses = 99; $('note').textContent = 'Microphone blocked. Tap the lock icon in the address bar and allow the microphone.'; } };
  } else $('note').textContent = !window.isSecureContext ? 'Microphone needs a secure (https) link. You can type for now.' : 'Speech recognition is not supported in this browser (use Chrome). You can type instead. The coach still talks.';
  function listen() { if (!rec || listening || busy) return; gotResult = false; try { rec.start(); listening = true; $('mic').classList.add('on'); $('mic').textContent = '🔴 Listening... tap to stop'; } catch (e) {} }
  function stopListening() { if (rec && listening) { try { rec.abort(); } catch (e) {} listening = false; } }
  // Barge-in: tapping the mic interrupts whoever is speaking
  $('mic').onclick = () => { unlockAudio(); misses = 0; if (listening) { misses = 99; stopListening(); return; } interrupt(); listen(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') { stopListening(); if (synth) synth.cancel(); } });

  $('txt').onkeydown = e => { if (e.key === 'Enter') { send(e.target.value); e.target.value = ''; } };
  $('start').onclick = () => { unlockAudio(); misses = 0; interrupt(); $('log').innerHTML = ''; play(eng.welcome()); };
  $('drive').onchange = e => send(e.target.checked ? 'driving mode on' : 'driving mode off');
  function renderActs() {
    const el = $('acts'); el.innerHTML = '';
    const list = eng.mode === 'menu' ? eng.activities() : [{ title: 'Change subject', say: 'change subject' }];
    list.forEach(a => { const b = document.createElement('button'); b.className = 'alt'; b.textContent = a.title; b.onclick = () => send(a.say || a.title); el.append(b); });
  }
  $('hist').onclick = () => {
    const p = eng.p;
    $('dlgbody').innerHTML = `<p>${eng.progressSummary()}</p><ol>${p.history.map(h => `<li><b>${new Date(h.t).toLocaleString()}</b>: ${h.activity} (score ${h.score}, +${h.xp} XP)<br><small></small></li>`).join('')}</ol>`;
    [...$('dlgbody').querySelectorAll('small')].forEach((s, i) => s.textContent = p.history[i].summary);
    $('dlg').showModal();
  };
  $('close').onclick = () => $('dlg').close();
  $('clear').onclick = () => { if (confirm('Delete all saved progress and history on this device?')) { localStorage.removeItem(KEY); eng.p = BrimEngine.newProfile(); save(); $('dlg').close(); $('log').innerHTML = ''; } };
  stats(); renderActs();
  show({ speaker: 'coach', text: 'Press "Start session" (browsers need one tap before audio can play).' });
})();
