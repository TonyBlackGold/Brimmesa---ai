// Local coaching gym. No network. Profile and per-coach state stay in localStorage.
(function (root) {
  const PROFILE_KEY = 'brimmesa.learner.profile.v1';
  const COACH_KEY = 'brimmesa.coachstate.v1';
  const MODES = ['conversation', 'coaching', 'challenge', 'freetalk'];
  const STEPS = ['explain', 'demo', 'scenario', 'response', 'adapt', 'evaluate', 'feedback', 'example', 'retry', 'record', 'next'];
  const STYLES = ['direct', 'warm', 'brief'];

  function strings(list, max, len) {
    if (!Array.isArray(list)) return [];
    return list.map(s => String(s || '').trim().slice(0, len)).filter(Boolean).slice(0, max);
  }
  function blankProfile() {
    return {
      lessons: [], skills: [], strengths: [], weaknesses: [],
      xp: 0, streak: 0, objectives: [], preferredStyle: 'direct',
      topic: '', thread: '', summary: '', recent: []
    };
  }
  function blankCoach() {
    return { step: 'explain', mode: 'conversation', topic: '', attempts: 0, lastFeedback: '', lastScore: null, record: [], updated: 0 };
  }
  function normalizeProfile(raw) {
    const p = blankProfile();
    if (!raw || typeof raw !== 'object') return p;
    p.lessons = Array.isArray(raw.lessons) ? raw.lessons.slice(0, 40) : [];
    p.skills = Array.isArray(raw.skills) ? raw.skills.slice(0, 40) : [];
    p.strengths = strings(raw.strengths, 12, 80);
    p.weaknesses = strings(raw.weaknesses, 12, 80);
    p.xp = Number(raw.xp) || 0;
    p.streak = Number(raw.streak) || 0;
    p.objectives = strings(raw.objectives, 8, 180);
    p.preferredStyle = STYLES.indexOf(raw.preferredStyle) >= 0 ? raw.preferredStyle : 'direct';
    p.topic = String(raw.topic || '').slice(0, 80);
    p.thread = String(raw.thread || '').slice(0, 120);
    p.summary = String(raw.summary || '').slice(0, 420);
    p.recent = Array.isArray(raw.recent) ? raw.recent.slice(-8).map(t => ({
      speaker: String((t && t.speaker) || 'user').slice(0, 24),
      text: String((t && t.text) || '').slice(0, 160)
    })).filter(t => t.text) : [];
    return p;
  }
  function normalizeCoach(raw) {
    const c = blankCoach();
    if (!raw || typeof raw !== 'object') return c;
    c.step = STEPS.indexOf(raw.step) >= 0 ? raw.step : 'explain';
    c.mode = MODES.indexOf(raw.mode) >= 0 ? raw.mode : 'conversation';
    c.topic = String(raw.topic || '').slice(0, 80);
    c.attempts = Number(raw.attempts) || 0;
    c.lastFeedback = String(raw.lastFeedback || '').slice(0, 240);
    c.lastScore = raw.lastScore == null || raw.lastScore === '' ? null : Number(raw.lastScore);
    c.record = Array.isArray(raw.record) ? raw.record.slice(-8) : [];
    c.updated = Number(raw.updated) || 0;
    return c;
  }
  function normalizeBoard(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(id => {
      if (!/^[a-z0-9-]{1,24}$/.test(id)) return;
      out[id] = normalizeCoach(raw[id]);
    });
    return out;
  }
  function storage(store) {
    if (store) return store;
    return {
      get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
      remove(k) { try { localStorage.removeItem(k); } catch (e) {} }
    };
  }
  function read(store, key, fallback) {
    try {
      const raw = storage(store).get(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function loadProfile(store) { return normalizeProfile(read(store, PROFILE_KEY, null)); }
  function saveProfile(profile, store) { storage(store).set(PROFILE_KEY, JSON.stringify(normalizeProfile(profile))); }
  function deleteProfile(store) { storage(store).remove(PROFILE_KEY); }
  function loadBoard(store) { return normalizeBoard(read(store, COACH_KEY, null)); }
  function saveBoard(board, store) { storage(store).set(COACH_KEY, JSON.stringify(normalizeBoard(board))); }
  function deleteBoard(store) { storage(store).remove(COACH_KEY); }
  function coachOf(board, id) { return normalizeCoach((board || {})[id]); }
  function putCoach(board, id, coach) {
    const next = Object.assign({}, board || {});
    next[id] = normalizeCoach(coach);
    return next;
  }

  const RETURN_RE = /\b(where were we|back to that|return to (that|the topic)|what were we (talking|working)|pick that back up)\b/i;
  function asksReturn(text) { return RETURN_RE.test(String(text || '')); }
  function compress(topic, recent) {
    const tail = (recent || []).slice(-3).map(t => (t.speaker === 'user' ? 'You' : t.speaker) + ': ' + t.text).join(' | ');
    const head = topic ? 'Topic: ' + topic + '.' : '';
    return (head + (tail ? ' Recent: ' + tail : '')).trim().slice(0, 420);
  }
  function noteTurn(profile, turn) {
    const p = normalizeProfile(profile);
    const speaker = String((turn && turn.speaker) || 'user').slice(0, 24);
    const text = String((turn && turn.text) || '').slice(0, 160);
    if (!text) return p;
    p.recent = p.recent.concat([{ speaker: speaker, text: text }]).slice(-8);
    if (speaker === 'user' && !asksReturn(text)) {
      if (/\b(change subject|new topic)\b/i.test(text)) p.thread = '';
      else if (!p.thread && text.split(/\s+/).filter(Boolean).length >= 4) p.thread = text.slice(0, 120);
      p.topic = text.slice(0, 80);
    }
    p.summary = compress(p.thread || p.topic, p.recent);
    return p;
  }
  function summaryText(profile) { return normalizeProfile(profile).summary; }
  function returnLine(profile) {
    const p = normalizeProfile(profile);
    const focus = p.thread || p.topic;
    if (!focus && !p.summary) return 'We have not landed on a topic yet. Tell me what you want to practice.';
    return 'We were on this: ' + (focus || p.summary) + '. Want to pick it back up?';
  }
  function handoffContext(profile) { return normalizeProfile(profile).summary; }

  function editProfile(profile, patch) {
    const p = normalizeProfile(profile);
    const src = patch || {};
    if (src.preferredStyle && STYLES.indexOf(src.preferredStyle) >= 0) p.preferredStyle = src.preferredStyle;
    if (src.objective) {
      const obj = String(src.objective).trim().slice(0, 180);
      if (obj && p.objectives.indexOf(obj) < 0) p.objectives = [obj].concat(p.objectives).slice(0, 8);
    }
    if (src.strength) {
      const s = String(src.strength).trim().slice(0, 80);
      if (s && p.strengths.indexOf(s) < 0) p.strengths = [s].concat(p.strengths).slice(0, 12);
    }
    if (src.weakness) {
      const w = String(src.weakness).trim().slice(0, 80);
      if (w && p.weaknesses.indexOf(w) < 0) p.weaknesses = [w].concat(p.weaknesses).slice(0, 12);
    }
    if (Array.isArray(src.objectives)) p.objectives = strings(src.objectives, 8, 180);
    if (Array.isArray(src.strengths)) p.strengths = strings(src.strengths, 12, 80);
    if (Array.isArray(src.weaknesses)) p.weaknesses = strings(src.weaknesses, 12, 80);
    if (src.xp != null) p.xp = Number(src.xp) || 0;
    if (src.streak != null) p.streak = Number(src.streak) || 0;
    if (Array.isArray(src.skills)) p.skills = src.skills.slice(0, 40);
    if (Array.isArray(src.lessons)) p.lessons = src.lessons.slice(0, 40);
    return p;
  }
  function applyLesson(profile, lesson, mirror) {
    const p = normalizeProfile(profile);
    if (lesson && lesson.id) p.lessons = [lesson].concat(p.lessons.filter(l => l.id !== lesson.id)).slice(0, 40);
    if (mirror) {
      if (mirror.xp != null) p.xp = Number(mirror.xp) || 0;
      if (mirror.streak != null) p.streak = Number(mirror.streak) || 0;
    }
    return p;
  }
  function noteProgress(profile, coachId, state) {
    const p = normalizeProfile(profile);
    const snap = {
      id: coachId + '-live',
      coach: coachId,
      title: (state && state.topic) || coachId,
      step: (state && state.step) || 'explain',
      status: 'in-progress',
      updated: (state && state.updated) || Date.now()
    };
    p.lessons = [snap].concat(p.lessons.filter(l => l.id !== snap.id)).slice(0, 40);
    return p;
  }

  function weakAnswer(text, score) {
    if (score && score.overall != null && score.overall < 55) return true;
    if (score && score.overall != null) return false;
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 6) return true;
    return !/\b(because|so that|so|reason|means)\b/i.test(text);
  }
  function demoLine(said) {
    const bit = String(said || '').slice(0, 90);
    return "Here is the shape, out loud. Claim: Morning walks make my whole day better. Reason: They clear my head before the kids wake up. I heard you say: " + bit + ". Your turn is next, in a real room.";
  }
  function scenarioLine(state) {
    const topic = (state && state.topic) || 'what you just said';
    return 'Scenario. Tell it to a friend who was not in the room. Use ' + topic + '. I will listen for the point and why it is true for you.';
  }
  function pushLine(said) {
    const bit = String(said || '').slice(0, 80);
    return "I'm going to push back. " + (bit ? 'I heard: ' + bit + '. ' : '') + 'A listener can still ask why. Add the reason it is true for you, the way a walk clears your head before the kids wake up.';
  }
  function feedbackBundle(said, score) {
    const tip = score && score.tip ? score.tip : 'Keep the point, then the reason.';
    const mark = score && score.overall != null ? ' That landed at ' + score.overall + '.' : '';
    const bit = String(said || '').slice(0, 70) || 'Morning walks make my whole day better';
    return 'Evaluate. Feedback.' + mark + ' ' + tip + ' Improved example: ' + bit + ', because it is true for you before the kids wake up. Try it once more, or say next.';
  }
  function recordLesson(state, said, opts, score) {
    const o = opts || {};
    const s = state;
    const title = (s.topic || 'Mindset').slice(0, 80);
    const lesson = {
      id: 'amara-' + (o.now || Date.now()),
      coach: 'amara',
      title: title,
      step: 'recorded',
      status: 'recorded',
      score: score && score.overall != null ? score.overall : s.lastScore,
      note: String(said || '').slice(0, 160),
      updated: o.now || Date.now()
    };
    s.record = (s.record || []).concat([lesson]).slice(-8);
    s.step = 'record';
    s.attempts = 0;
    s.lastFeedback = ('Recorded ' + title).slice(0, 240);
    s.updated = lesson.updated;
    return { state: s, say: 'Recorded. That attempt stays on this device under ' + title + '. Say next when you want a new pass.', lesson: lesson, covered: ['record'] };
  }

  // One learner turn, one spoken beat. Evaluate, feedback, and the improved example share a turn so the learner is not waiting on three silent states.
  function amaraBeat(state, text, opts) {
    const o = opts || {};
    const s = normalizeCoach(state);
    s.mode = 'coaching';
    if (o.topic) s.topic = String(o.topic).slice(0, 80);
    const said = String(text || '').trim();
    s.updated = o.now || Date.now();
    if (!said) {
      s.step = 'explain';
      return { state: s, say: o.explain || "I'm Amara. A claim is the point, in one plain sentence, and a reason is why that point is true for you. For example, claim: Morning walks make my whole day better. Reason: They clear my head before the kids wake up. Try one from your own week. You can skip ahead if this is already easy.", covered: ['explain'] };
    }
    if (!s.topic && !/^\s*(next|move on|new topic)\b/i.test(said)) s.topic = said.slice(0, 80);
    if (s.step === 'explain') {
      s.step = 'demo';
      return { state: s, say: demoLine(said), covered: ['demo'] };
    }
    if (s.step === 'demo') {
      s.step = 'scenario';
      return { state: s, say: scenarioLine(s), covered: ['scenario'] };
    }
    if (s.step === 'scenario') {
      s.step = 'response';
      return { state: s, say: 'Your turn. ' + scenarioLine(s), covered: ['response'] };
    }
    if (s.step === 'record') {
      s.step = 'next';
      s.attempts = 0;
      return { state: s, say: 'Next. Say another one, or tell me a new topic.', covered: ['next'] };
    }
    if (s.step === 'next') {
      s.step = 'demo';
      s.attempts = 0;
      return { state: s, say: demoLine(said), covered: ['demo'] };
    }
    if ((s.step === 'retry' || s.step === 'example' || s.step === 'feedback' || s.step === 'evaluate') && /^\s*(next|move on|new topic)\b/i.test(said)) {
      return recordLesson(s, said, o, null);
    }
    if (s.step === 'response' || s.step === 'adapt' || s.step === 'retry' || s.step === 'evaluate' || s.step === 'feedback' || s.step === 'example') {
      const score = typeof o.score === 'function' ? o.score(said) : null;
      if (weakAnswer(said, score) && s.attempts < 1) {
        s.attempts += 1;
        s.step = 'adapt';
        s.lastScore = score && score.overall != null ? score.overall : s.lastScore;
        return { state: s, say: pushLine(said), covered: ['adapt'] };
      }
      if (s.step === 'retry' || s.step === 'example' || s.step === 'feedback' || s.step === 'evaluate') {
        if (score && score.overall != null) s.lastScore = score.overall;
        return recordLesson(s, said, o, score);
      }
      s.lastScore = score && score.overall != null ? score.overall : s.lastScore;
      s.lastFeedback = feedbackBundle(said, score).slice(0, 240);
      s.step = 'retry';
      return { state: s, say: feedbackBundle(said, score), covered: ['evaluate', 'feedback', 'example'] };
    }
    s.step = 'demo';
    return { state: s, say: demoLine(said), covered: ['demo'] };
  }

  function challengeBeat(text) {
    const said = String(text || '').trim().slice(0, 90);
    if (said.length < 8) return 'Challenge. Give me the point, then why it is true for you. I will not let a short answer stand.';
    return 'Challenge. I am not buying it yet. ' + said + ' Add the reason a skeptical friend would need, then stop.';
  }

  const api = {
    PROFILE_KEY, COACH_KEY, MODES, STEPS, STYLES,
    blankProfile, blankCoach, normalizeProfile, normalizeCoach,
    loadProfile, saveProfile, deleteProfile, loadBoard, saveBoard, deleteBoard,
    coachOf, putCoach, noteTurn, asksReturn, summaryText, returnLine, handoffContext,
    editProfile, applyLesson, noteProgress, amaraBeat, challengeBeat
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.BrimGym = api;
})(typeof window !== 'undefined' ? window : globalThis);
