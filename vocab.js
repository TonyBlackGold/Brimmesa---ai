// Curated vocabulary and a one-minute speaking rep. No network.
(function (root) {
  const LEVELS = ['starter', 'steady', 'sharp'];
  let WORDS = [];
  let TOPICS = ['a habit you want to keep', 'a problem you can explain in one minute', 'advice you would give a friend'];

  function load(doc) {
    const src = doc || {};
    WORDS = Array.isArray(src.words) ? src.words : [];
    if (Array.isArray(src.topics) && src.topics.length) TOPICS = src.topics.map(t => String(t)).slice(0, 8);
  }
  function byId(id) { return WORDS.find(w => w.id === id) || null; }
  function sanitize(raw) {
    const v = { level: 'starter', day: '', todayId: '', box: {}, speechTopic: '' };
    if (!raw || typeof raw !== 'object') return v;
    if (LEVELS.indexOf(raw.level) >= 0) v.level = raw.level;
    v.day = String(raw.day || '').slice(0, 10);
    v.todayId = String(raw.todayId || '').slice(0, 40);
    v.speechTopic = String(raw.speechTopic || '').slice(0, 80);
    if (raw.box && typeof raw.box === 'object') {
      Object.keys(raw.box).slice(0, 40).forEach(id => {
        const row = raw.box[id] || {};
        v.box[String(id).slice(0, 40)] = {
          n: Number(row.n) || 0,
          due: Number(row.due) || 0,
          ease: Math.max(1, Math.min(4, Number(row.ease) || 1))
        };
      });
    }
    return v;
  }
  function dayKey(now) { return new Date(now).toISOString().slice(0, 10); }
  function promote(state) {
    const known = level => WORDS.filter(w => w.level === level && state.box[w.id] && state.box[w.id].n > 0).length;
    if (state.level === 'starter' && known('starter') >= 4) state.level = 'steady';
    else if (state.level === 'steady' && known('steady') >= 4) state.level = 'sharp';
    return state;
  }
  function wordFor(track, now, opts) {
    const state = promote(sanitize(track));
    const skip = opts && opts.skipId;
    const day = dayKey(now);
    if (!skip && state.day === day && state.todayId) {
      const same = byId(state.todayId);
      if (same) return { track: state, word: same };
    }
    const due = WORDS.filter(w => {
      const row = state.box[w.id];
      return row && row.due && row.due <= now && w.id !== skip;
    }).sort((a, b) => state.box[a.id].due - state.box[b.id].due);
    const fresh = WORDS.filter(w => w.level === state.level && w.id !== skip && !(state.box[w.id] && state.box[w.id].n));
    const sameLevel = WORDS.filter(w => w.level === state.level && w.id !== skip);
    const pick = due[0] || fresh[0] || sameLevel[0] || WORDS.find(w => w.id !== skip) || WORDS[0] || null;
    if (pick) { state.day = day; state.todayId = pick.id; }
    return { track: state, word: pick };
  }
  function companions(track, word) {
    const level = (word && word.level) || (track && track.level) || 'starter';
    return WORDS.filter(w => w.level === level && (!word || w.id !== word.id)).slice(0, 2);
  }
  function gradeSentence(track, text, word, now) {
    const state = sanitize(track);
    const target = word || byId(state.todayId);
    if (!target) return { track: state, line: 'I do not have a word loaded. Say vocabulary and I will start one.' };
    const said = String(text || '');
    const used = new RegExp('\\b' + String(target.word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(said);
    const wordsN = said.split(/\s+/).filter(Boolean).length;
    const row = state.box[target.id] || { n: 0, due: 0, ease: 1 };
    let line;
    if (used && wordsN >= 6) {
      row.n += 1;
      row.ease = Math.min(4, (row.ease || 1) + 1);
      row.due = now + [0, 1, 3, 7, 14][row.ease] * 86400000;
      line = 'You used ' + target.word + ' in a sentence. I will bring it back for review. Say next word when you want another.';
    } else if (used) {
      line = 'I heard ' + target.word + '. Make the sentence long enough to stand on its own, then say it again.';
    } else {
      row.due = now + 3600000;
      line = 'I did not hear ' + target.word + '. It means ' + target.meaning + ' Example: ' + target.example;
    }
    state.box[target.id] = row;
    return { track: promote(state), line: line };
  }
  function speechTopic(text, now) {
    const raw = String(text || '');
    const m = raw.match(/\bpublic speaking\b(?:\s+(?:about|on)\s+|\s+)(.+)/i);
    if (m && m[1] && !/^(about|on)$/i.test(m[1].trim())) {
      const topic = m[1].replace(/[.?!].*$/, '').trim().slice(0, 80);
      if (topic && !/^public speaking$/i.test(topic)) return topic;
    }
    const list = TOPICS.length ? TOPICS : ['a habit you want to keep'];
    return list[new Date(now).getUTCDate() % list.length];
  }
  function speechInvite(topic) {
    return 'Public speaking. Give me about sixty seconds on ' + topic + '. I will score fillers, pace, and pauses, then give one tip.';
  }
  function speechRetry(topic) {
    return 'Same topic: ' + topic + '. About sixty seconds. Go ahead.';
  }

  const api = {
    LEVELS, load, sanitize, byId, wordFor, companions, gradeSentence,
    speechTopic, speechInvite, speechRetry
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.BrimVocab = api;
})(typeof window !== 'undefined' ? window : globalThis);
