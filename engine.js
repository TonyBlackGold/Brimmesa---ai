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
  // ctx.scripted() is the current engine turn. The shell selects ScriptedProvider.
  // LLMProvider is a Phase 2 stub: disabled, no API key, and no network call.
  const ScriptedProvider = { name: 'scripted', enabled: true, async respond(ctx) { return ctx.scripted(); } };
  const LLMProvider = { name: 'llm', enabled: false, model: null, async respond(ctx) { return ctx.scripted(); } };

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
      if (!p.name) { this.mode = 'askname'; return [this.C("Welcome to BRIMMESA AI. I'm Amara, your personal coach. What should I call you?")]; }
      let msg = `Welcome back, ${p.name}! You're level ${level(p.xp)} with ${p.xp} XP` + (p.streak ? ` and a ${p.streak}-day streak.` : '.');
      if (p.lastFeedback) msg += ` Last time: ${p.lastFeedback}`;
      L.push(this.C(msg)); L.push(this.menuPrompt()); this.mode = 'menu'; return L;
    }
    menuPrompt() {
      const opts = this.activities().filter(a => !this.p.driving || a.driving).map(a => a.title.toLowerCase());
      const weak = this.weakest();
      const rec = weak ? ` I'd recommend ${weak.title.toLowerCase()}, since that's where you have the most room to grow.` : '';
      const drive = this.p.driving ? ' Driving mode is on, so I keep it short and audio-only. Save the social scenarios for when you are parked.' : '';
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
          return [this.C((this.area && this.area.nudge) || 'Tell me which area you want, or say reflect.')];
        }
        return [this.C("I didn't catch which one. You can say social, communication, or Security plus.")];
      }
      if (this.mode === 'reflect') {
        const ctx = { text, t, scripted: () => this.reflectTurn(text, t) };
        return this.provider.respond(ctx, this);
      }
      const ctx = { text, t, scripted: () => this[this.act.type + 'Turn'](text, t) };
      return this.provider.respond(ctx, this);
    }

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

    scenarioTurn(text, t) {
      const c = this.content[this.act.id], s = this.s, sig = c.signals, R = c.responses; const out = [];
      s.turn++;
      const found = Object.keys(sig).filter(k => has(t, sig[k]));
      found.forEach(k => s.hit[k] = true);
      if (found.includes('pushy')) { out.push(...R.pushy); return out.concat(this.endScenario()); }
      if (s.turn === 1) out.push(...((found.includes('greeting') || found.includes('context') || found.includes('humor')) ? R.open_good : R.open_flat));
      else {
        const order = ['intro', 'humor', 'inclusive', 'context', 'question'];
        const k = order.find(x => found.includes(x));
        out.push(...(k ? R[k] : R.neutral));
      }
      if (found.includes('exit')) { out.splice(0, out.length, ...R.exit); return out.concat(this.endScenario()); }
      if (s.turn >= c.maxTurns) { out.push(...R.timeout); return out.concat(this.endScenario()); }
      return out;
    }
    endScenario() {
      const c = this.content[this.act.id], hit = this.s.hit;
      let score = c.rubric.reduce((a, r) => a + (hit[r.id] ? r.points : 0), 0);
      const pen = c.penalties.filter(p => hit[p.id]); pen.forEach(p => score -= p.points); score = Math.max(0, score);
      const good = c.rubric.filter(r => hit[r.id]).map(r => r.label.toLowerCase());
      const tips = pen.map(p => p.tip).concat(c.rubric.filter(r => !hit[r.id]).map(r => r.tip)).slice(0, 2);
      return this.finish(c.skill, score, good, tips, 'the spice aisle scenario');
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
      this.mode = 'menu'; this.act = null;
      const extra = (r.improved ? ' That beats your personal best, so you earn bonus XP!' : '') + (r.levelUp ? ` Level up! You're now level ${level(this.p.xp)}.` : '');
      return [this.C(`Coach feedback on ${fb} You earned ${r.xp} XP.${extra}`), this.menuPrompt()];
    }
    progressSummary() {
      const p = this.p, parts = Object.entries(p.mastery).filter(([, v]) => v.best !== undefined).map(([k, v]) => `${k} best ${v.best}`);
      return `Level ${level(p.xp)}, ${p.xp} XP, ${p.streak}-day streak. ${parts.join('; ') || 'No activities completed yet.'}`;
    }
  }

  // Optional LLM provider (disabled by default; no key shipped). Points at any OpenAI-compatible endpoint, ideally a small server proxy so keys never reach the browser.
  function makeHttpProvider({ endpoint, model }) {
    return { name: 'http', async respond(ctx, eng) {
      try {
        const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, activity: eng.act && eng.act.id, profile: { name: eng.p.name, mastery: eng.p.mastery }, user: ctx.text }) });
        const j = await r.json(); return j.lines; // expected: [{speaker, text}]
      } catch (e) { return ctx.scripted(); } // fall back to scripted engine on any failure
    } };
  }

  const api = { Engine, newProfile, level, awardXP, touchStreak, ScriptedProvider, LLMProvider, makeHttpProvider };
  if (typeof module !== 'undefined') module.exports = api; else root.BrimEngine = api;
})(this);
