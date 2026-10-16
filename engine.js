// BRIMMESA AI engine: pure logic, no DOM. Works in browser (window.BrimEngine) and Node (module.exports).
(function (root) {
  const DAY = 86400000;
  const has = (t, list) => (list || []).some(w => t.includes(w));
  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

  function newProfile() {
    return { name: null, xp: 0, streak: 0, lastDay: null, mastery: {}, history: [], lastActivity: null, lastFeedback: null, driving: false };
  }
  function level(xp) { return Math.floor(Math.sqrt(xp / 50)) + 1; }

  // Update the streak for activity on day `now`
  function touchStreak(p, now) {
    const today = dayKey(now);
    if (p.lastDay === today) return;
    const yesterday = dayKey(now - DAY);
    p.streak = p.lastDay === yesterday ? p.streak + 1 : 1;
    p.lastDay = today;
  }

  // XP rewards demonstrated improvement: base on score, bonus for beating your personal best, little for repeats at the same level.
  function awardXP(p, skill, score) {
    const m = p.mastery[skill] || (p.mastery[skill] = { attempts: 0, best: 0, last: 0 });
    const improvement = Math.max(0, score - m.best);
    const xp = Math.round(score * 0.2 + improvement * 0.6) + (m.attempts === 0 ? 5 : 0);
    m.attempts++; m.last = score; m.best = Math.max(m.best, score);
    m.mastered = m.best >= 85;
    const before = level(p.xp); p.xp += xp;
    return { xp, improved: improvement > 0 && m.attempts > 1, levelUp: level(p.xp) > before };
  }

  // ConversationProvider: { name, enabled, respond(ctx, engine) -> Promise<{speaker, text}[]> }.
  // ctx.scripted() is the current engine turn. The page uses ScriptedProvider until
  // the shell assigns a createLLMProvider() instance that has a browser-held key.
  const ScriptedProvider = { name: 'scripted', enabled: true, async respond(ctx) { return ctx.scripted(); } };

  class Engine {
    constructor({ worlds, content, profile, provider, now, areas }) {
      this.worlds = worlds; this.content = content; // content: {activityId: json}
      this.p = profile || newProfile();
      this.provider = provider && provider.enabled !== false ? provider : ScriptedProvider;
      this.now = now || (() => Date.now());
      this.mode = 'menu'; this.act = null; this.s = null;
      this.areas = areas || [];
      this.area = null;
    }
    norm(s) { return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim(); }
    activities() { return this.worlds.worlds.flatMap(w => w.activities.map(a => ({ ...a, world: w.title }))); }
    C(text) { return { speaker: 'coach', text }; }

    welcome() {
      const p = this.p, L = [];
      if (!p.name) { this.mode = 'askname'; return [this.C("Welcome to BRIMMESA AI. I'm Aria, your guide. What should I call you?")]; }
      let msg = `Welcome back, ${p.name}! You're level ${level(p.xp)} with ${p.xp} XP` + (p.streak ? ` and a ${p.streak}-day streak.` : '.');
      if (p.lastFeedback) msg += ` Last time: ${p.lastFeedback}`;
      L.push(this.C(msg)); L.push(this.menuPrompt()); this.mode = 'menu'; return L;
    }
    menuPrompt() {
      const opts = this.activities().filter(a => !this.p.driving || a.driving).map(a => a.title.toLowerCase());
      const weak = this.weakest();
      const rec = weak ? ` I'd recommend ${weak.title.toLowerCase()}, since that's where you have the most room to grow.` : '';
      const drive = this.p.driving ? ' Driving mode is on, so I keep it short and audio-only. Save the social scenarios for when you are parked.' : '';
      if (opts.length > 4) return this.C(`Pick a destination on the map, or name a practice.${rec}${drive}`);
      return this.C(`What would you like to practice: ${opts.join(', ')}?${rec}${drive}`);
    }
    weakest() {
      const acts = this.activities().filter(a => !this.p.driving || a.driving);
      const scored = acts.map(a => ({ a, best: (this.p.mastery[this.content[a.id].skill] || {}).best ?? -1 }));
      const tried = scored.filter(x => x.best >= 0 && x.best < 85).sort((x, y) => x.best - y.best);
      return tried.length ? tried[0].a : null;
    }
    pick(text) {
      const t = text.toLowerCase();
      return this.activities().find(a => has(t, a.keywords) || t.includes(a.title.toLowerCase()));
    }
    pickArea(text) {
      if (!this.areas.length) return null;
      const t = this.norm(text);
      let best = null, score = 0;
      for (const area of this.areas) {
        const title = this.norm(area.title);
        if (title && t.includes(title)) return area;
        for (const k of area.keywords || []) {
          const key = this.norm(k);
          if (key && t.includes(key) && key.length > score) { best = area; score = key.length; }
        }
      }
      return best;
    }
    // An area command wins when the phrase names that area, without stealing
    // short activity commands such as "communication" or "security plus".
    areaCommandWins(text, area, activity) {
      if (!area) return false;
      const t = this.norm(text);
      if (t.includes(this.norm(area.title))) return true;
      const actWords = new Set();
      this.activities().forEach(a => (a.keywords || []).forEach(k => actWords.add(this.norm(k))));
      return (area.keywords || []).some(k => {
        const key = this.norm(k);
        return key && t.includes(key) && !actWords.has(key);
      });
    }
    openArea(area) {
      this.area = area; this.mode = 'area'; this.act = null; this.s = null;
      return [this.C(area.intro)];
    }
    startReflection() {
      const prompts = (this.area && this.area.reflections) || [];
      if (!prompts.length) return [this.C('I am still writing the reflections for this area.')];
      this.mode = 'reflect';
      this.s = { i: 0, hits: 0 };
      touchStreak(this.p, this.now());
      return [this.C(prompts[0].prompt)];
    }

    async handle(raw) {
      const text = (raw || '').trim(); const t = text.toLowerCase();
      if (!text) return [this.C("I didn't catch that. Could you say it again?")];
      // Global voice commands
      if (/\b(driving mode on|i'?m driving|start driving)\b/.test(t)) { this.p.driving = true; this.mode = 'menu'; return [this.C('Driving mode on. Short audio questions only.'), this.menuPrompt()]; }
      if (/\b(driving mode off|i'?m parked|stop driving)\b/.test(t)) { this.p.driving = false; return [this.C('Driving mode off.'), this.menuPrompt()]; }
      if (this.mode !== 'menu' && this.mode !== 'askname' && /\b(stop|quit|exit|change (the )?subject|something else|main menu|menu)\b/.test(t)) {
        this.mode = 'menu'; this.act = null; return [this.C("No problem, let's switch."), this.menuPrompt()];
      }
      if (/\b(my progress|how am i doing|stats)\b/.test(t)) return [this.C(this.progressSummary())];

      if (this.mode === 'askname') {
        const m = text.match(/(?:call me|my name is|i'm|i am|it's)\s+([a-z'-]+)/i);
        this.p.name = (m ? m[1] : text.split(/\s+/)[0]).replace(/[^a-z'-]/gi, '');
        this.p.name = this.p.name.charAt(0).toUpperCase() + this.p.name.slice(1);
        this.mode = 'menu';
        return [this.C(`Great to meet you, ${this.p.name}. You can say what you want to practice anytime, or say "change subject" to switch.`), this.menuPrompt()];
      }
      if (this.mode === 'menu' || this.mode === 'area') {
        const areaHit = this.pickArea(text);
        const a = this.pick(text);
        const areaWins = this.areaCommandWins(text, areaHit, a);
        const sameArea = this.mode === 'area' && this.area && areaHit && areaHit.id === this.area.id;
        if (areaWins && !sameArea) return this.openArea(areaHit);
        if (a) {
          if (this.p.driving && !a.driving) return [this.C("That one needs your full attention, so let's save it for when you're parked. Try communication or Security plus.")];
          if (this.mode === 'menu') this.area = null;
          return this.start(a);
        }
        if (this.mode === 'area') {
          if (/\b(reflect|reflection)\b/.test(t)) return this.startReflection();
          const nudge = () => [this.C((this.area && this.area.nudge) || 'Tell me which area you want, or say reflect.')];
          if (this.llmOn()) return this.provider.respond({ text, t, kind: 'area', scripted: nudge }, this);
          return nudge();
        }
        const miss = () => [this.C("I didn't catch which one. You can say social, communication, or Security plus.")];
        if (this.llmOn()) return this.provider.respond({ text, t, kind: 'coach', scripted: miss }, this);
        return miss();
      }
      if (this.mode === 'reflect') {
        const ctx = { text, t, kind: 'reflect', scripted: () => this.reflectTurn(text, t) };
        return this.provider.respond(ctx, this);
      }
      const ctx = { text, t, kind: this.mode, scripted: () => this[this.act.type + 'Turn'](text, t) };
      return this.provider.respond(ctx, this);
    }
    llmOn() { return !!(this.provider && this.provider.enabled && this.provider.name === 'llm'); }

    start(a) {
      this.act = a; this.mode = a.type; const c = this.content[a.id];
      touchStreak(this.p, this.now());
      if (a.type === 'scenario') { this.s = { turn: 0, hit: {}, ended: false }; return [this.C(c.setting)]; }
      if (a.type === 'drill') { this.s = { round: 0, scores: [] }; return [this.C(c.intro)]; }
      if (a.type === 'quiz') {
        const n = this.p.driving ? 3 : c.lessonSize;
        const order = [...c.items].sort((x, y) => this.itemPriority(c, y) - this.itemPriority(c, x)).slice(0, n);
        this.s = { order, i: 0, correct: 0, results: [] };
        const first = order[0];
        return [this.C(`${c.cert} ${c.examCode} lesson, ${n} questions. ${this.p.driving ? '' : c.disclaimer + ' '}${this.p.driving ? '' : first.teach + ' '}Question 1: ${first.q}`)];
      }
    }
    // Personalized review: prioritize items missed before, then unseen, then domain weight
    itemPriority(c, it) {
      const rec = (this.p.mastery['secplus.items'] || {})[it.id];
      const dom = c.domains.find(d => d.id === it.domain);
      return (rec === false ? 100 : rec === undefined ? 50 : 0) + dom.weight / 10;
    }

    // Updates spice-aisle (or any scenario) signals without awarding XP.
    // scenarioTurn keeps the scripted lines and the scripted score.
    advanceScenario(text, t) {
      const c = this.content[this.act.id], s = this.s, sig = c.signals, R = c.responses;
      const out = [];
      s.turn++;
      const found = Object.keys(sig).filter(k => has(t, sig[k]));
      found.forEach(k => s.hit[k] = true);
      let ended = false;
      if (found.includes('pushy')) { out.push(...R.pushy); ended = true; }
      else if (s.turn === 1) out.push(...((found.includes('greeting') || found.includes('context') || found.includes('humor')) ? R.open_good : R.open_flat));
      else {
        const order = ['intro', 'humor', 'inclusive', 'context', 'question'];
        const k = order.find(x => found.includes(x));
        out.push(...(k ? R[k] : R.neutral));
      }
      if (!ended && found.includes('exit')) { out.splice(0, out.length, ...R.exit); ended = true; }
      if (!ended && s.turn >= c.maxTurns) { out.push(...R.timeout); ended = true; }
      return { npc: out, ended, found };
    }
    scenarioTurn(text, t) {
      const preview = this.advanceScenario(text, t);
      if (preview.ended) return preview.npc.concat(this.endScenario());
      return preview.npc;
    }
    endScenario() {
      const c = this.content[this.act.id], hit = this.s.hit;
      let score = c.rubric.reduce((a, r) => a + (hit[r.id] ? r.points : 0), 0);
      const pen = c.penalties.filter(p => hit[p.id]); pen.forEach(p => score -= p.points); score = Math.max(0, score);
      const good = c.rubric.filter(r => hit[r.id]).map(r => r.label.toLowerCase());
      const tips = pen.map(p => p.tip).concat(c.rubric.filter(r => !hit[r.id]).map(r => r.tip)).slice(0, 2);
      const label = c.feedbackLabel || 'the spice aisle scenario';
      return this.finish(c.skill, score, good, tips, label);
    }

    drillTurn(text, t) {
      const c = this.content[this.act.id], s = this.s, out = [];
      if (s.round > 0) { // grade response to the previous interruption
        const words = t.split(/\s+/).filter(Boolean).length; let sc = 0; const hit = [];
        c.rubric.forEach(r => { const ok = r.words ? has(t, r.words) : words <= r.maxWords; if (ok) { sc += r.points; hit.push(r.id); } });
        c.penalties.forEach(p => { if (has(t, p.words)) { sc -= p.points; hit.push(p.id); } });
        s.scores.push({ sc: Math.max(0, sc), hit });
        const miss = c.rubric.find(r => !hit.includes(r.id));
        out.push(this.C(hit.includes('hostile') ? c.penalties[0].tip : miss ? `Quick note: ${miss.tip}` : 'Excellent. Calm, clear, and in control.'));
      }
      if (s.round < c.rounds.length) { out.push(c.rounds[s.round]); s.round++; return out; }
      const score = Math.round(s.scores.reduce((a, x) => a + x.sc, 0) / s.scores.length);
      const counts = id => s.scores.filter(x => x.hit.includes(id)).length;
      const good = c.rubric.filter(r => counts(r.id) >= 2).map(r => r.label.toLowerCase());
      const tips = c.rubric.filter(r => counts(r.id) < 2).map(r => r.tip).slice(0, 2);
      return out.concat(this.finish(c.skill, score, good, tips, 'the interruptions drill'));
    }

    quizTurn(text, t) {
      const c = this.content[this.act.id], s = this.s, it = s.order[s.i], out = [];
      if (/\b(repeat|say (that|it) again)\b/.test(t)) return [this.C(it.q)];
      const ok = /\b(don'?t know|no idea|skip|pass)\b/.test(t) ? false : has(t, it.accept);
      const items = this.p.mastery['secplus.items'] || (this.p.mastery['secplus.items'] = {});
      items[it.id] = ok; if (ok) s.correct++;
      s.results.push({ id: it.id, domain: it.domain, ok });
      out.push(this.C((ok ? 'Correct! ' : 'Not quite. ') + it.explain));
      s.i++;
      if (s.i < s.order.length) { const n = s.order[s.i]; out.push(this.C(`${this.p.driving ? '' : n.teach + ' '}Question ${s.i + 1}: ${n.q}`)); return out; }
      const score = Math.round(100 * s.correct / s.order.length);
      const missedDomains = [...new Set(s.results.filter(r => !r.ok).map(r => c.domains.find(d => d.id === r.domain).name))];
      const tips = missedDomains.length ? [`Next time we'll review ${missedDomains.join(' and ')}.`] : ['Perfect round. I will raise the difficulty as more items are added.'];
      const dom = this.p.mastery['secplus.domains'] || (this.p.mastery['secplus.domains'] = {});
      s.results.forEach(r => { const d = dom[r.domain] || (dom[r.domain] = { seen: 0, correct: 0 }); d.seen++; if (r.ok) d.correct++; });
      return out.concat(this.finish(c.skill, score, [`${s.correct} of ${s.order.length} correct`], tips, 'Security plus'));
    }

    reflectTurn(text) {
      const prompts = this.area.reflections;
      const cur = prompts[this.s.i];
      const words = text.split(/\s+/).filter(Boolean).length;
      if (words >= 4) this.s.hits++;
      const out = [this.C(cur.reply)];
      this.s.i++;
      if (this.s.i < prompts.length) { out.push(this.C(prompts[this.s.i].prompt)); return out; }
      const score = Math.round(70 + (this.s.hits / prompts.length) * 30);
      const skill = this.area.skill || ('reflect.' + this.area.id);
      const r = awardXP(this.p, skill, score);
      const fb = `${this.area.title} reflection: you stayed with ${prompts.length} questions.`;
      this.p.lastFeedback = fb;
      this.p.lastActivity = 'area:' + this.area.id;
      this.p.history.unshift({ t: this.now(), activity: this.area.title + ' reflection', score, xp: r.xp, summary: fb });
      this.p.history = this.p.history.slice(0, 50);
      this.mode = 'area'; this.s = null;
      out.push(this.C(`That is enough for now. You earned ${r.xp} XP.${r.levelUp ? ` Level up! You're now level ${level(this.p.xp)}.` : ''} Say an activity, or name another area.`));
      return out;
    }

    finish(skill, score, good, tips, label) {
      const r = awardXP(this.p, skill, score);
      const fb = `${label}: score ${score}. ${good.length ? 'Strengths: ' + good.join(', ') + '.' : ''} ${tips.length ? 'Work on: ' + tips.join(' ') : ''}`.replace(/\s+/g, ' ').trim();
      this.p.lastFeedback = fb; this.p.lastActivity = this.act.id;
      this.p.history.unshift({ t: this.now(), activity: this.act.title, score, xp: r.xp, summary: fb });
      this.p.history = this.p.history.slice(0, 50);
      if (score >= 70 && this.act) {
        this.p.missions = this.p.missions || {};
        this.p.missions[this.act.id] = { score: score, t: this.now() };
      }
      const scene = this.act && this.content[this.act.id];
      let dims = '';
      if (scene && scene.dimensions && this.s && this.s.hit) {
        const bits = scene.dimensions.map(d => {
          const ids = d.signals || [];
          const got = ids.filter(id => this.s.hit[id]).length;
          return d.label + ' ' + Math.round(100 * got / Math.max(1, ids.length));
        });
        dims = ' Scores: ' + bits.join(', ') + '.';
      }
      this.mode = 'menu'; this.act = null;
      const extra = (r.improved ? ' That beats your personal best, so you earn bonus XP!' : '') + (r.levelUp ? ` Level up! You're now level ${level(this.p.xp)}.` : '');
      return [this.C(`Coach feedback on ${fb}${dims} You earned ${r.xp} XP.${extra}`), this.menuPrompt()];
    }
    progressSummary() {
      const p = this.p, parts = Object.entries(p.mastery).filter(([, v]) => v.best !== undefined).map(([k, v]) => `${k} best ${v.best}`);
      return `Level ${level(p.xp)}, ${p.xp} XP, ${p.streak}-day streak. ${parts.join('; ') || 'No activities completed yet.'}`;
    }
  }

  const GEMINI_MODEL = 'gemini-3.5-flash-lite';
  const EMOTIONS = ['laugh', 'concern', 'smile', 'surprise'];
  const SPEAKERS = { amara: 'coach', coach: 'coach', aria: 'aria', jasmine: 'jasmine', renee: 'renee', marcus: 'marcus' };
  const RATE_LINE = "Google's free tier is rate-limited right now. I'll use the practice script for this turn.";
  const ALLOWANCE_LINE = "That's today's free AI allowance. I'll keep going from the practice script until tomorrow.";
  const LINES_SCHEMA = {
    type: 'OBJECT',
    properties: {
      lines: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            speaker: { type: 'STRING' },
            text: { type: 'STRING' },
            emotion: { type: 'STRING' }
          },
          required: ['speaker', 'text']
        }
      }
    },
    required: ['lines']
  };
  const SCORE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      score: { type: 'INTEGER' },
      strengths: { type: 'ARRAY', items: { type: 'STRING' } },
      tips: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['score', 'strengths', 'tips']
  };

  function geminiError(status) {
    const err = new Error('gemini');
    err.status = status || 0;
    return err;
  }

  // Browser Gemini provider. enabled stays false on this object. The shell builds
  // an instance with createLLMProvider and supplies the key from localStorage.
  // Nothing here logs the key, the request URL, or the response body.
  const LLMProvider = {
    name: 'llm',
    enabled: false,
    model: GEMINI_MODEL,
    dailyLimit: 50,
    getKey() { return ''; },
    getModel() { return this.model || GEMINI_MODEL; },
    getCast() { return []; },
    now() { return Date.now(); },
    fetchImpl: null,
    readUsage() { return { day: '', count: 0 }; },
    writeUsage() {},
    readMemory() { return []; },
    writeMemory() {},
    dayStamp() {
      const ts = typeof this.now === 'function' ? this.now() : Date.now();
      const d = new Date(ts);
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    usageNow() {
      let u = { day: '', count: 0 };
      try { u = this.readUsage() || u; } catch (e) { u = { day: '', count: 0 }; }
      const day = this.dayStamp();
      return { day, count: u.day === day ? (Number(u.count) || 0) : 0 };
    },
    bumpUsage() {
      const u = this.usageNow();
      try { this.writeUsage({ day: u.day, count: u.count + 1 }); } catch (e) {}
    },
    overLimit() { return this.usageNow().count >= (this.dailyLimit || 50); },
    persona(id) {
      const cast = this.getCast() || [];
      const row = cast.find(c => c.id === id || c.speakerId === id || (id === 'coach' && (c.id === 'amara' || c.speakerId === 'coach')));
      if (!row) return id;
      const manners = (row.mannerisms || []).join(', ');
      return (row.name || id) + ' (' + (row.role || 'coach') + '): ' + (row.personality || '') + (manners ? ' Mannerisms: ' + manners + '.' : '');
    },
    lengthRule(eng) {
      const brand = 'Write the brand as Brimmesa, in mixed case, never in all capitals.';
      const pace = eng && eng.p && eng.p.driving
        ? 'Driving mode: one short spoken sentence. No lists.'
        : 'Reply in 1 to 3 short spoken sentences. Voice-friendly. No lists, no markdown.';
      return pace + ' ' + brand;
    },
    areaContext(eng) {
      const areas = (eng && eng.areas) || [];
      const list = areas.map(a => a.title + ' (' + (a.summary || '') + ')').join('; ');
      const here = eng && eng.area
        ? 'Current area: ' + eng.area.title + '. ' + (eng.area.intro || '') + ' If they stall: ' + (eng.area.nudge || '')
        : 'No roadmap area is open.';
      return here + (list ? ' Eight areas: ' + list + '.' : '');
    },
    progressBlock(eng) {
      const summary = eng.progressSummary();
      const strengths = [];
      const working = [];
      Object.entries((eng.p && eng.p.mastery) || {}).forEach(([k, v]) => {
        if (!v || v.best == null || !v.attempts) return;
        (v.best >= 85 ? strengths : working).push(k + ' ' + v.best);
      });
      const mem = (this.readMemory() || []).slice(-10).map(t => (t.role || 'coach') + ': ' + t.text).join('\n');
      const last = eng.p && eng.p.lastFeedback ? String(eng.p.lastFeedback).slice(0, 240) : '';
      const goal = eng.p && eng.p.goal ? '\nUser goal: ' + String(eng.p.goal).slice(0, 180) : '';
      return 'Progress: ' + summary + goal
        + '\nStrengths: ' + (strengths.join(', ') || 'none yet')
        + '\nWorking on: ' + (working.join(', ') || 'none yet')
        + (last ? '\nLast feedback: ' + last : '')
        + '\nRecent turns:\n' + (mem || '(none)');
    },
    remember(userText, lines) {
      let prev = [];
      try { prev = (this.readMemory() || []).slice(-10); } catch (e) { prev = []; }
      const next = prev.concat([{ role: 'user', text: String(userText || '').slice(0, 400) }]);
      (lines || []).forEach(l => {
        if (l && l.text && l.speaker !== 'user') next.push({ role: l.speaker || 'coach', text: String(l.text).slice(0, 400) });
      });
      try { this.writeMemory(next.slice(-10)); } catch (e) {}
    },
    extractText(json) {
      const parts = ((((json || {}).candidates || [])[0] || {}).content || {}).parts || [];
      return parts.filter(p => p && p.text && !p.thought).map(p => p.text).join('\n')
        .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    },
    parseJSON(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (e) {
        const m = String(text).match(/[\[{][\s\S]*[\]}]/);
        if (!m) return null;
        try { return JSON.parse(m[0]); } catch (e2) { return null; }
      }
    },
    clip(text, driving) {
      let t = String(text || '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
      if (driving) {
        const m = t.match(/.*?[.!?](?:\s|$)/);
        t = (m ? m[0] : t).trim();
      }
      return t.slice(0, driving ? 180 : 400);
    },
    normalizeLines(raw, allowed, driving) {
      const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.lines) ? raw.lines : (raw && raw.text ? [raw] : []));
      const out = [];
      for (const item of arr) {
        if (!item) continue;
        const speaker = SPEAKERS[String(item.speaker || '').toLowerCase()];
        if (!speaker || (allowed && allowed.indexOf(speaker) < 0)) continue;
        const text = this.clip(item.text, driving);
        if (!text) continue;
        const line = { speaker, text };
        const emotion = String(item.emotion || '').toLowerCase();
        if (EMOTIONS.indexOf(emotion) >= 0) line.emotion = emotion;
        out.push(line);
        if (out.length >= (driving ? 1 : 3)) break;
      }
      return out;
    },
    async generate(prompt, schema) {
      const key = this.getKey ? this.getKey() : '';
      if (!key) throw geminiError(0);
      const model = (this.getModel && this.getModel()) || this.model || GEMINI_MODEL;
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
      const fetchFn = this.fetchImpl || (typeof fetch === 'function' ? fetch : null);
      if (!fetchFn) throw geminiError(0);
      const send = (withSchema) => {
        const generationConfig = { temperature: 0.7, maxOutputTokens: 512 };
        if (withSchema && schema) {
          generationConfig.responseMimeType = 'application/json';
          generationConfig.responseSchema = schema;
        }
        return fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig })
        });
      };
      let res;
      try { res = await send(true); }
      catch (e) { throw geminiError(0); }
      if (res && res.status === 400 && schema) {
        try { res = await send(false); }
        catch (e) { throw geminiError(0); }
      }
      if (!res || !res.ok) throw geminiError(res && res.status);
      this.bumpUsage();
      try { return this.extractText(await res.json()); }
      catch (e) { return ''; }
    },
    async testConnection(keyOverride) {
      const typed = keyOverride && String(keyOverride).trim();
      const key = typed || (this.getKey ? this.getKey() : '');
      if (!key) return 'Add a key first.';
      const prev = this.getKey;
      this.getKey = () => key;
      try {
        const text = await this.generate('Reply with JSON {"lines":[{"speaker":"coach","text":"Ready."}]}. Say nothing else.', LINES_SCHEMA);
        const got = this.normalizeLines(this.parseJSON(text), ['coach'], false);
        return got.length ? 'Connected. This device can reach Gemini.' : 'Gemini answered, but the reply was not the expected JSON. The practice script still works.';
      } catch (e) {
        const s = e && e.status;
        if (s === 429) return "Google's free tier is rate-limited right now. The practice script still works.";
        if (s === 400) return 'Gemini rejected the model id. Check the model name in Settings.';
        if (s === 401 || s === 403) return 'Gemini rejected that key. Check it in Google AI Studio and try again.';
        return 'Could not reach Gemini. The practice script still works.';
      } finally {
        this.getKey = prev;
      }
    },
    rate(lines) {
      return [{ speaker: 'coach', text: RATE_LINE }].concat(lines || []);
    },
    async respond(ctx, eng) {
      if (!this.enabled || !(this.getKey && this.getKey())) return ctx.scripted();
      if (this.overLimit()) {
        const lines = await ctx.scripted();
        return [{ speaker: 'coach', text: ALLOWANCE_LINE }].concat(lines || []);
      }
      if (ctx.kind === 'scenario') return this.scenario(ctx, eng);
      if (ctx.kind === 'drill') return this.drill(ctx, eng);
      if (ctx.kind === 'quiz') return this.quiz(ctx, eng);
      if (ctx.kind === 'reflect') return this.reflect(ctx, eng);
      return this.chat(ctx, eng);
    },
    async scenario(ctx, eng) {
      const preview = eng.advanceScenario(ctx.text, ctx.t);
      const scene = eng.content[eng.act.id] || {};
      if ((preview.found || []).indexOf('pushy') >= 0) {
        const tail = preview.ended ? eng.endScenario() : [];
        return preview.npc.concat(tail);
      }
      const driving = !!(eng.p && eng.p.driving);
      let npc = preview.npc;
      let limited = false;
      let talked = false;
      const allowed = (scene.characters || []).map(ch => ch.id).filter(id => SPEAKERS[id]);
      const castIds = allowed.length ? allowed : ['jasmine', 'renee'];
      try {
        const prompt = [
          scene.sceneNote || 'Adults only. This is a respectful coaching scene in a grocery spice aisle. No sexual content, no pressure, no appearance ratings, no contact details, no private meetups.',
          'If the user is pushy, the characters set a short boundary and stop the chat.',
          'Do not speak as the user. Speak only as: ' + castIds.join(', ') + '.',
          castIds.map(id => this.persona(id)).join('\n'),
          'Scene: ' + (scene.setting || ''),
          this.lengthRule(eng),
          'Return JSON {"lines":[{"speaker":"' + castIds[0] + '","text":"...","emotion":"smile"}]}. emotion is smile, concern, laugh, or surprise. One to three lines, each one speaker.',
          this.areaContext(eng),
          this.progressBlock(eng),
          'User said: ' + ctx.text
        ].join('\n');
        const text = await this.generate(prompt, LINES_SCHEMA);
        const lines = this.normalizeLines(this.parseJSON(text), castIds, driving);
        if (lines.length) { npc = lines; talked = true; }
      } catch (e) {
        npc = preview.npc;
        limited = !!(e && e.status === 429);
      }
      let tail = [];
      if (preview.ended) {
        const c = scene;
        const scored = limited ? null : await this.scoreScenario(ctx, eng, preview);
        const label = c.feedbackLabel || 'the spice aisle scenario';
        if (scored) tail = eng.finish(c.skill, scored.score, scored.strengths, scored.tips, label);
        else tail = eng.endScenario();
      }
      const spoken = (limited ? [{ speaker: 'coach', text: RATE_LINE }] : []).concat(npc, tail);
      if (talked) this.remember(ctx.text, spoken.filter(l => l.text !== RATE_LINE));
      return spoken;
    },
    async scoreScenario(ctx, eng, preview) {
      const c = eng.content[eng.act.id];
      const prompt = [
        'Score this adult practice scene. Return JSON with integer score from 0 to 100, strengths, and tips.',
        'Rubric: ' + (c.rubric || []).map(r => r.id + ' ' + r.points + ' ' + r.label).join('; '),
        'Penalties: ' + (c.penalties || []).map(p => p.id + ' -' + p.points + ' ' + p.label).join('; '),
        'Signals noticed in the user text: ' + (preview.found || []).join(', '),
        'No sexual content in the tips. Two short phrases at most for strengths and for tips.',
        'User said: ' + ctx.text
      ].join('\n');
      try {
        const j = this.parseJSON(await this.generate(prompt, SCORE_SCHEMA)) || {};
        const score = Number(j.score);
        if (!Number.isFinite(score) || score < 0 || score > 100) return null;
        const strengths = (Array.isArray(j.strengths) ? j.strengths : []).map(s => String(s).slice(0, 80)).filter(Boolean).slice(0, 3);
        const tips = (Array.isArray(j.tips) ? j.tips : []).map(s => String(s).slice(0, 120)).filter(Boolean).slice(0, 2);
        return { score: Math.round(score), strengths, tips };
      } catch (e) { return null; }
    },
    async drill(ctx, eng) {
      const lines = await ctx.scripted();
      const marcus = (lines || []).find(l => l.speaker === 'marcus');
      if (!marcus) return lines;
      try {
        const prompt = [
          'Adults only. Professional meeting. No insults, no appearance comments, no sexual content.',
          this.persona('marcus'),
          'Marcus interrupts so the user can practice staying calm. Speak only as Marcus, one line.',
          this.lengthRule(eng),
          'Return JSON {"lines":[{"speaker":"marcus","text":"...","emotion":"concern"}]}.',
          this.areaContext(eng),
          this.progressBlock(eng),
          'User said: ' + ctx.text
        ].join('\n');
        const got = this.normalizeLines(this.parseJSON(await this.generate(prompt, LINES_SCHEMA)), ['marcus'], !!(eng.p && eng.p.driving));
        if (got[0]) {
          marcus.text = got[0].text;
          if (got[0].emotion) marcus.emotion = got[0].emotion;
        }
        this.remember(ctx.text, lines);
      } catch (e) {
        if (e && e.status === 429) lines.unshift({ speaker: 'coach', text: RATE_LINE });
      }
      return lines;
    },
    async quiz(ctx, eng) {
      const lines = await ctx.scripted();
      try {
        const prompt = [
          this.persona('amara'),
          'Security+ tutor. The app already graded this answer against the original question. Do not rewrite the question, do not change the verdict, and do not invent a new item.',
          'Add one short study sentence in your own words.',
          this.lengthRule(eng),
          'Return JSON {"lines":[{"speaker":"coach","text":"...","emotion":"smile"}]}.',
          'Verdict already shown to the learner: ' + ((lines[0] && lines[0].text) || ''),
          this.progressBlock(eng),
          'User said: ' + ctx.text
        ].join('\n');
        const got = this.normalizeLines(this.parseJSON(await this.generate(prompt, LINES_SCHEMA)), ['coach'], !!(eng.p && eng.p.driving));
        if (got[0]) lines.splice(1, 0, got[0]);
        this.remember(ctx.text, got.length ? got : lines.slice(0, 1));
      } catch (e) {
        if (e && e.status === 429) lines.unshift({ speaker: 'coach', text: RATE_LINE });
      }
      return lines;
    },
    async reflect(ctx, eng) {
      const lines = await ctx.scripted();
      try {
        const prompt = [
          'Adults only. Respectful coaching. No sexual content.',
          this.persona('amara'),
          'Rephrase only the acknowledgement of what the user just said. Do not ask the next question. Do not mention XP.',
          'Stay close to this acknowledgement: ' + ((lines[0] && lines[0].text) || ''),
          this.lengthRule(eng),
          'Return JSON {"lines":[{"speaker":"coach","text":"...","emotion":"smile"}]}.',
          this.areaContext(eng),
          this.progressBlock(eng),
          'User said: ' + ctx.text
        ].join('\n');
        const got = this.normalizeLines(this.parseJSON(await this.generate(prompt, LINES_SCHEMA)), ['coach'], !!(eng.p && eng.p.driving));
        if (got[0] && lines[0] && lines[0].speaker === 'coach') {
          lines[0].text = got[0].text;
          if (got[0].emotion) lines[0].emotion = got[0].emotion;
        }
        this.remember(ctx.text, lines);
      } catch (e) {
        if (e && e.status === 429) lines.unshift({ speaker: 'coach', text: RATE_LINE });
      }
      return lines;
    },
    async chat(ctx, eng) {
      const driving = !!(eng.p && eng.p.driving);
      try {
        const prompt = [
          'Adults only. Respectful life coaching. No sexual content, no pressure, no appearance ratings, no contact details.',
          this.persona('amara'),
          'You are Coach Amara. Speak only as coach. If they want a scored activity, suggest social, communication, or Security plus.',
          this.lengthRule(eng),
          'Return JSON {"lines":[{"speaker":"coach","text":"...","emotion":"smile"}]}. emotion is smile, concern, laugh, or surprise.',
          this.areaContext(eng),
          this.progressBlock(eng),
          'User said: ' + ctx.text
        ].join('\n');
        const got = this.normalizeLines(this.parseJSON(await this.generate(prompt, LINES_SCHEMA)), ['coach'], driving);
        if (!got.length) return ctx.scripted();
        this.remember(ctx.text, got);
        return got;
      } catch (e) {
        const lines = await ctx.scripted();
        return (e && e.status === 429) ? this.rate(lines) : lines;
      }
    }
  };

  function createLLMProvider(config) {
    return Object.assign(Object.create(LLMProvider), config || {});
  }

  // Older optional adapter. This page does not construct it and it ships no key.
  function makeHttpProvider({ endpoint, model }) {
    return { name: 'http', async respond(ctx, eng) {
      try {
        const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, activity: eng.act && eng.act.id, profile: { name: eng.p.name, mastery: eng.p.mastery }, user: ctx.text }) });
        const j = await r.json(); return j.lines; // expected: [{speaker, text}]
      } catch (e) { return ctx.scripted(); } // fall back to scripted engine on any failure
    } };
  }

  // Slots only. Realistic avatar and HeyGen are not built. ElevenLabs already speaks when a key is saved on the device.
  const futureHooks = {
    realisticAvatar: { implemented: false },
    heygen: { implemented: false }
  };

  const api = { Engine, newProfile, level, awardXP, touchStreak, ScriptedProvider, LLMProvider, createLLMProvider, makeHttpProvider, futureHooks };
  if (typeof module !== 'undefined') module.exports = api; else root.BrimEngine = api;
})(this);
