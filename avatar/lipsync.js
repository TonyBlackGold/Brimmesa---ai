// Text-timed viseme plan for speechSynthesis.
// The browser will not expose speech audio, so timing is estimated and
// corrected later if SpeechSynthesisUtterance.onboundary reports elapsedTime.

export function wordPlan(text, rate) {
  const raw = String(text || '');
  const words = [];
  const spans = [];
  const re = /[A-Za-z0-9']+/g;
  let match;
  while ((match = re.exec(raw))) {
    words.push(match[0]);
    spans.push([match.index, match.index + match[0].length]);
  }
  const scale = 1 / Math.max(0.6, Math.min(1.6, rate || 1));
  let t = Math.round(90 * scale);
  const wtimes = [];
  const wdurations = [];
  for (const word of words) {
    const dur = Math.round(Math.max(150, 68 * word.length + 36) * scale);
    wtimes.push(t);
    wdurations.push(dur);
    t += dur + Math.round(34 * scale);
  }
  return {
    text: raw,
    words,
    spans,
    wtimes,
    wdurations,
    visemes: [],
    vtimes: [],
    vdurations: [],
    total: t + Math.round(180 * scale)
  };
}

export function fillVisemes(plan, lipsync) {
  const visemes = [];
  const vtimes = [];
  const vdurations = [];
  const fallback = !lipsync;
  plan.words.forEach((word, i) => {
    const piece = fallback ? roughVisemes(word) : fromLibrary(word, lipsync);
    if (!piece.visemes.length) return;
    const dTotal = piece.times[piece.times.length - 1] + piece.durations[piece.durations.length - 1];
    if (dTotal <= 0) return;
    const duration = plan.wdurations[i];
    for (let j = 0; j < piece.visemes.length; j++) {
      visemes.push(piece.visemes[j]);
      vtimes.push(Math.round(plan.wtimes[i] + (piece.times[j] / dTotal) * duration));
      vdurations.push(Math.max(40, Math.round((piece.durations[j] / dTotal) * duration)));
    }
  });
  plan.visemes = visemes;
  plan.vtimes = vtimes;
  plan.vdurations = vdurations;
  return plan;
}

function fromLibrary(word, lipsync) {
  const prepared = typeof lipsync.preProcessText === 'function' ? lipsync.preProcessText(word) : word;
  const val = lipsync.wordsToVisemes(prepared || word) || {};
  return {
    visemes: val.visemes || [],
    times: val.times || [],
    durations: val.durations || []
  };
}

function roughVisemes(word) {
  const table = {
    a: 'aa', e: 'E', i: 'I', o: 'O', u: 'U',
    p: 'PP', b: 'PP', m: 'PP', f: 'FF', v: 'FF',
    d: 'DD', t: 'DD', k: 'kk', c: 'kk', g: 'kk', q: 'kk',
    s: 'SS', z: 'SS', n: 'nn', l: 'nn', r: 'RR', w: 'U', y: 'I',
    j: 'CH', h: 'aa'
  };
  const visemes = [];
  const times = [];
  const durations = [];
  const lower = word.toLowerCase();
  let clock = 0;
  for (let i = 0; i < lower.length; i++) {
    let key = lower[i];
    if (lower.slice(i, i + 2) === 'th') { key = 'TH'; i++; }
    else if (lower.slice(i, i + 2) === 'ch' || lower.slice(i, i + 2) === 'sh') { key = 'CH'; i++; }
    const vis = key === 'TH' || key === 'CH' ? key : table[key];
    if (!vis) continue;
    visemes.push(vis);
    times.push(clock);
    durations.push(80);
    clock += 80;
  }
  if (!visemes.length) {
    visemes.push('aa');
    times.push(0);
    durations.push(120);
  }
  return { visemes, times, durations };
}

export function shiftPlan(plan, index) {
  const base = plan.wtimes[index] || 0;
  const words = plan.words.slice(index);
  const spans = plan.spans.slice(index);
  const wtimes = plan.wtimes.slice(index).map(t => Math.max(0, t - base + 20));
  const wdurations = plan.wdurations.slice(index);
  const visemes = [];
  const vtimes = [];
  const vdurations = [];
  for (let i = 0; i < plan.vtimes.length; i++) {
    if (plan.vtimes[i] + plan.vdurations[i] < base) continue;
    visemes.push(plan.visemes[i]);
    vtimes.push(Math.max(0, plan.vtimes[i] - base + 20));
    vdurations.push(plan.vdurations[i]);
  }
  const last = wtimes.length ? wtimes[wtimes.length - 1] + wdurations[wtimes.length - 1] : 200;
  return {
    text: plan.text,
    words,
    spans,
    wtimes,
    wdurations,
    visemes,
    vtimes,
    vdurations,
    total: last + 160
  };
}

export function wordIndex(spans, charIndex) {
  const at = charIndex || 0;
  for (let i = 0; i < spans.length; i++) {
    if (at < spans[i][1]) return i;
  }
  return spans.length ? spans.length - 1 : -1;
}

export function emotionFromText(text) {
  const raw = String(text || '');
  const s = raw.toLowerCase();
  if (/\b(ha(ha)+|lol+|lmao|rofl|hehe)\b/.test(s) || /😂|🤣/.test(raw)) return 'laugh';
  if (/\b(wow|whoa|unbelievable|no way|surprise[d]?)\b/.test(s) || /😱|😮|😲/.test(raw)) return 'surprise';
  if (/\b(sorry|worried|anxious|anxiety|concerned|afraid|sad|upset|nervous)\b/.test(s)) return 'concern';
  if (/\b(smile|glad|nice|great|love|happy|wonderful|thanks|thank you)\b/.test(s)) return 'smile';
  return null;
}
