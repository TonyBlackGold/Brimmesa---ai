// Headless end-to-end test of the six prototype requirements: node test.js
const fs = require('fs'), assert = require('assert');
const { Engine, newProfile, level } = require('./engine.js');
const worlds = JSON.parse(fs.readFileSync('data/worlds.json'));
const content = {}; worlds.worlds.forEach(w => w.activities.forEach(a => content[a.id] = JSON.parse(fs.readFileSync(a.file))));
let clock = Date.parse('2026-10-14T15:00:00Z'); const now = () => clock;
const say = async (e, t) => { const r = await e.handle(t); console.log('  YOU:', t); r.forEach(l => console.log(`  ${l.speaker.toUpperCase()}: ${l.text}`)); return r; };
(async () => {
  let e = new Engine({ worlds, content, profile: newProfile(), now });
  console.log('1) welcome'); e.welcome().forEach(l => console.log('  COACH:', l.text));
  await say(e, "call me Tony");
  assert.equal(e.p.name, 'Tony');
  console.log('3) two-character social scenario');
  await say(e, "let's do the social grocery one");
  await say(e, "Hey! Honestly that smoked paprika is dangerous, I put it in everything");
  await say(e, "I'm Tony by the way. What are you two cooking?");
  const r = await say(e, "Cinnamon in chili, I'll try it. Nice meeting you both, enjoy!");
  assert(r.some(l => l.speaker === 'jasmine') && e.p.mastery['social.approach'].best >= 80);
  console.log('4) communication drill');
  await say(e, "communication"); await say(e, "First point: we route by zip code.");
  await say(e, "Fair point Marcus. Let me finish this point, then I'll cover last year.");
  await say(e, "Great question, I'll get to the budget in a moment.");
  await say(e, "I hear you. Let me finish, it's simpler than it sounds.");
  assert(e.p.mastery['comm.interruptions'].best >= 90);
  console.log('5) Security+ lesson'); await say(e, "security plus");
  const ans = { q1: 'availability', q2: 'integrity', q3: 'spear phishing', q4: "I don't know", q5: 'segmentation', q6: 'mfa', q7: 'containment', q8: 'transfer' };
  for (let i = 0; i < 4; i++) await say(e, ans[e.s.order[i].id]);
  assert(e.p.mastery.secplus.attempts === 1);
  console.log('2) persistence + memory of progress (new session from saved JSON, next day)');
  const saved = JSON.stringify(e.p); clock += 86400000;
  e = new Engine({ worlds, content, profile: JSON.parse(saved), now });
  const w = e.welcome(); w.forEach(l => console.log('  COACH:', l.text));
  assert(/Welcome back, Tony/.test(w[0].text) && /Last time/.test(w[0].text));
  await say(e, "security"); // missed items should come first
  console.log('  first item after review prioritization:', e.s.order[0].id);
  await say(e, "change subject"); assert.equal(e.mode, 'menu');
  await say(e, "I'm driving"); const d = await say(e, "social"); assert(/parked/.test(d[0].text));
  console.log('6) XP/progress:', e.progressSummary(), '| level', level(e.p.xp));
  assert(e.p.xp > 0 && e.p.streak === 2 && e.p.history.length === 3);

  console.log('7) Gemini provider (mocked fetch, no network)');
  const { createLLMProvider } = require('./engine.js');
  const areas = JSON.parse(fs.readFileSync('data/areas.json')).areas;
  const cast = JSON.parse(fs.readFileSync('data/characters.json')).characters;
  const SECRET = 'unit-test-key-not-a-real-secret';
  const gemini = obj => ({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: JSON.stringify(obj) }] } }] });
  const fixedNow = () => Date.parse('2026-10-15T15:00:00Z');
  function makeLLM(opts) {
    const state = { usage: { day: '', count: 0 }, memory: [], calls: [] };
    const llm = createLLMProvider({
      enabled: opts.enabled !== false,
      getKey: () => (opts.key === undefined ? SECRET : opts.key),
      getModel: () => opts.model || 'gemini-3.5-flash-lite',
      getCast: () => cast,
      now: fixedNow,
      readUsage: () => state.usage,
      writeUsage: u => { state.usage = u; },
      readMemory: () => state.memory,
      writeMemory: m => { state.memory = m; },
      fetchImpl: async (url, req) => {
        state.calls.push({ url, req });
        const header = String((req.headers && req.headers['x-goog-api-key']) || '');
        assert(header);
        assert(!String(url).includes(header));
        assert(!String(req.body).includes(header));
        assert(!String(url).includes('key='));
        if (opts.fetchImpl) return opts.fetchImpl(url, req, state);
        const prompt = JSON.parse(req.body).contents[0].parts[0].text;
        const payload = prompt.includes('Score this adult practice scene')
          ? { score: 88, strengths: ['warm exit'], tips: ['invite both people in'] }
          : { lines: [
            { speaker: 'Jasmine', text: 'Custom aisle line from Jasmine.', emotion: 'smile' },
            { speaker: 'Renee', text: 'Custom aisle line from Renee.', emotion: 'concern' }
          ] };
        return { ok: true, status: 200, json: async () => gemini(payload) };
      }
    });
    return { llm, state };
  }
  function brain(opts) {
    const made = makeLLM(opts || {});
    const eng = new Engine({ worlds, content, profile: newProfile(), areas, provider: made.llm, now: fixedNow });
    return Object.assign(made, { eng });
  }

  {
    const { eng, state } = brain({ key: '' });
    await eng.handle('social');
    const r = await eng.handle('Hey');
    assert(r.some(l => /Ha, hi!/.test(l.text)));
    assert.equal(state.calls.length, 0);
    assert.equal(await eng.provider.testConnection(), 'Add a key first.');
  }
  {
    const { eng, state } = brain();
    await eng.handle('social');
    const r = await eng.handle('Hey');
    assert(r.some(l => l.speaker === 'jasmine' && l.text === 'Custom aisle line from Jasmine.' && l.emotion === 'smile'));
    assert(r.some(l => l.speaker === 'renee' && l.emotion === 'concern'));
    assert(!r.some(l => /smoked paprika/.test(l.text)));
    assert.equal(state.calls.length, 1);
    assert(state.calls[0].url.includes('generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'));
    assert.equal(state.calls[0].req.headers['x-goog-api-key'], SECRET);
    assert(!JSON.stringify(state.memory).includes(SECRET));
    assert(state.memory.length <= 10);
  }
  {
    const { eng } = brain();
    await eng.handle('social');
    const r = await eng.handle('Nice meeting you, enjoy!');
    assert(r.some(l => l.speaker === 'jasmine' && /Custom aisle line/.test(l.text)));
    assert.equal(eng.p.mastery['social.approach'].best, 88);
    assert(/88/.test(eng.p.lastFeedback));
    assert.equal(eng.mode, 'menu');
    assert(!/smoked paprika/.test(r.map(l => l.text).join(' ')));
  }
  {
    const { eng } = brain({
      fetchImpl: async (url, req) => {
        const prompt = JSON.parse(req.body).contents[0].parts[0].text;
        const payload = prompt.includes('Score this adult practice scene')
          ? { score: 'nope', strengths: [], tips: [] }
          : { lines: [{ speaker: 'jasmine', text: 'Model spice line.', emotion: 'laugh' }, { speaker: 'renee', text: 'Still shopping with her.', emotion: 'smile' }] };
        return { ok: true, status: 200, json: async () => gemini(payload) };
      }
    });
    await eng.handle("let's do the social grocery one");
    await eng.handle("Hey! Honestly that smoked paprika is dangerous, I put it in everything");
    await eng.handle("I'm Tony by the way. What are you two cooking?");
    const r = await eng.handle("Cinnamon in chili, I'll try it. Nice meeting you both, enjoy!");
    assert(r.some(l => /Model spice line/.test(l.text)));
    assert.equal(eng.p.mastery['social.approach'].best, 100);
    assert(/score 100/.test(eng.p.lastFeedback));
  }
  {
    const { eng, state } = brain({ fetchImpl: async () => { throw new Error('offline'); } });
    await eng.handle('social');
    const r = await eng.handle('Hey');
    assert(r.some(l => /Ha, hi!/.test(l.text)));
    assert(!r.some(l => /rate-limited/.test(l.text)));
    assert.equal(state.usage.count || 0, 0);
  }
  {
    const { eng, state } = brain({ fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: 'nope' }) }) });
    await eng.handle('social');
    const r = await eng.handle('Hey');
    assert(r.some(l => /Ha, hi!/.test(l.text)));
    assert(r.some(l => /rate-limited/.test(l.text)));
    assert.equal(state.usage.count || 0, 0);
    assert.equal(await eng.provider.testConnection(), "Google's free tier is rate-limited right now. The practice script still works.");
  }
  {
    const { eng, llm, state } = brain();
    state.usage = { day: llm.dayStamp(), count: 50 };
    const r = await eng.handle('tell me something useful');
    assert(r.some(l => /free AI allowance/.test(l.text)));
    assert(r.some(l => /didn't catch which one/.test(l.text)));
    assert.equal(state.calls.length, 0);
  }
  {
    const { eng } = brain({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => gemini({ lines: [{ speaker: 'coach', text: 'Tutor tip stays extra.', emotion: 'smile' }] }) })
    });
    await eng.handle('security plus');
    const first = eng.s.order[0];
    const next = eng.s.order[1];
    const r = await eng.handle(first.accept[0]);
    assert.equal(eng.p.mastery['secplus.items'][first.id], true);
    assert(r.some(l => l.text.includes(first.explain)));
    assert(r.some(l => l.text.includes(next.q)));
    assert(r.some(l => l.text.includes('Tutor tip stays extra.')));
  }
  {
    const { eng, state } = brain({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => gemini({ lines: [{ speaker: 'Amara', text: 'Area model line.', emotion: 'angry' }] }) })
    });
    await eng.handle('mindset');
    const r = await eng.handle('I want a calmer evening');
    assert.equal(r[0].speaker, 'coach');
    assert.equal(r[0].text, 'Area model line.');
    assert.equal(r[0].emotion, undefined);
    assert(state.calls[0].req.body.includes('Mindset'));
    assert(state.calls[0].req.body.includes('Eight areas'));
    const plain = new Engine({ worlds, content, profile: newProfile(), areas, now: fixedNow });
    await plain.handle('mindset');
    const nudge = await plain.handle('I want a calmer evening');
    assert(/Say reflect/.test(nudge[0].text));
  }
  {
    const { eng, state } = brain({ fetchImpl: async () => { throw new Error('should not be called for a pushy line'); } });
    await eng.handle('social');
    const r = await eng.handle('you are hot, give me your number');
    assert(r.some(l => /just shopping/.test(l.text)));
    assert.equal(state.calls.length, 0);
    assert.equal(eng.mode, 'menu');
  }
  {
    const { eng } = brain({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => gemini({ lines: [{ speaker: 'marcus', text: 'Hold on, the budget.', emotion: 'surprise' }] }) })
    });
    await eng.handle('communication');
    const r = await eng.handle('First point: we route by zip code.');
    const marcus = r.find(l => l.speaker === 'marcus');
    assert.equal(marcus.text, 'Hold on, the budget.');
    assert.equal(marcus.emotion, 'surprise');
  }
  {
    const prompt = areas.find(a => a.id === 'mindset').reflections[1].prompt;
    const { eng } = brain({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => gemini({ lines: [{ speaker: 'coach', text: 'Noted your standard.', emotion: 'smile' }] }) })
    });
    await eng.handle('mindset');
    await eng.handle('reflect');
    const r = await eng.handle('I kept my morning standard');
    assert.equal(r[0].text, 'Noted your standard.');
    assert(r.some(l => l.text === prompt));
    assert.equal(eng.mode, 'reflect');
  }
  {
    let n = 0;
    const { eng, state } = brain({
      model: 'gemini-3.8-flash',
      fetchImpl: async (url, req) => {
        n++;
        const body = JSON.parse(req.body);
        if (n === 1) {
          assert(body.generationConfig.responseSchema);
          return { ok: false, status: 400, json: async () => ({}) };
        }
        assert(!body.generationConfig.responseSchema);
        assert(!body.generationConfig.responseMimeType);
        return { ok: true, status: 200, json: async () => gemini({ lines: [{ speaker: 'coach', text: 'Still with you.', emotion: 'smile' }] }) };
      }
    });
    const r = await eng.handle('tell me something useful');
    assert.equal(r[0].text, 'Still with you.');
    assert(state.calls[0].url.includes('models/gemini-3.8-flash:generateContent'));
    assert.equal(state.usage.count, 1);
    const off = createLLMProvider({ enabled: false, fetchImpl: async () => { throw new Error('disabled provider must not fetch'); } });
    const quiet = new Engine({ worlds, content, profile: newProfile(), provider: off, now: fixedNow });
    const miss = await quiet.handle('tell me something useful');
    assert(/didn't catch which one/.test(miss[0].text));
  }
  {
    const { llm } = makeLLM({
      fetchImpl: async (url, req) => {
        assert.equal(req.headers['x-goog-api-key'], 'typed-once');
        return { ok: false, status: 403, json: async () => ({}) };
      }
    });
    assert(/rejected that key/.test(await llm.testConnection('typed-once')));
    assert.equal(llm.getKey(), SECRET);
  }

  console.log('\nALL TESTS PASSED');
})().catch(err => { console.error('FAIL', err); process.exit(1); });
