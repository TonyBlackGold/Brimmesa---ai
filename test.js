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
    assert(state.calls[0].req.body.includes('Roadmap:'));
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
  {
    const { state } = brain({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => gemini({ lines: [{ speaker: 'coach', text: 'Brimmesa is the name.', emotion: 'smile' }] }) })
    });
    const eng = new Engine({ worlds, content, profile: newProfile(), areas, provider: createLLMProvider({
      enabled: true,
      getKey: () => SECRET,
      getCast: () => cast,
      now: fixedNow,
      readUsage: () => ({ day: '', count: 0 }),
      writeUsage() {},
      readMemory: () => [],
      writeMemory() {},
      fetchImpl: async (url, req) => {
        state.calls.push({ url, req });
        return { ok: true, status: 200, json: async () => gemini({ lines: [{ speaker: 'coach', text: 'Here with you.', emotion: 'smile' }] }) };
      }
    }), now: fixedNow });
    await eng.handle('tell me something useful');
    const prompt = JSON.parse(state.calls[0].req.body).contents[0].parts[0].text;
    assert(prompt.includes('Write the brand as Brimmesa'));
    assert(!prompt.includes('BRIMMESA'));
  }

  console.log('8) speech pronunciation and Gemini TTS');
  const speech = require('./speech.js');
  assert.equal(speech.pronounce('Welcome to BRIMMESA AI.', 'word'), 'Welcome to Brimmesa AI.');
  assert.equal(speech.pronounce('brimmesa', 'word'), 'Brimmesa');
  assert.equal(speech.spokenText('BRIMMESA', 'gemini'), 'Brimmesa');
  assert.equal(speech.spokenText('BRIMMESA', 'basic'), 'Brih-meh-sah');
  assert.equal(speech.browserSpells({ name: 'Google US English' }), false);
  assert.equal(speech.browserSpells({ name: 'Fred' }), true);
  assert.deepEqual(speech.sentences('Hello there. How are you?'), ['Hello there.', 'How are you?']);
  const fitted = speech.fitWords('Hi Brimmesa', 1000);
  assert.equal(fitted.words.join(' '), 'Hi Brimmesa');
  assert(fitted.wtimes[0] === 0 && fitted.wdurations.reduce((a, b) => a + b, 0) >= 1000);
  const wav = speech.encodeWav(new Uint8Array(48), 24000);
  const parsed = speech.parseWav(wav);
  assert.equal(parsed.sampleRate, 24000);
  assert.equal(parsed.pcm.length, 48);
  const b64 = Buffer.from(wav).toString('base64');
  const cache = new Map();
  let ttsCalls = 0;
  const voice = speech.createSpeaker({
    getKey: () => SECRET,
    now: fixedNow,
    readUsage: () => ttsUsage,
    writeUsage: u => { ttsUsage = u; },
    cacheGet: async k => cache.get(k) || null,
    cacheSet: async (k, bytes) => { cache.set(k, bytes); },
    fetchImpl: async (url, req) => {
      ttsCalls++;
      const header = req.headers['x-goog-api-key'];
      assert.equal(header, SECRET);
      assert(!url.includes(SECRET) && !req.body.includes(SECRET) && !url.includes('key='));
      assert(url.includes('/v1beta/interactions'));
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'gemini-3.8-flash-lite-tts');
      assert.equal(body.input[0].content[0].text, 'Welcome to Brimmesa AI.');
      assert.equal(body.generation_config.speech_config[0].voice, 'Sulafat');
      assert(/warm/.test(body.input[0].content[0].annotations[0].style));
      return { ok: true, status: 200, json: async () => ({ output_audio: { data: b64, mime_type: 'audio/wav' } }) };
    }
  });
  let ttsUsage = { day: '', count: 0 };
  const said = await voice.synthesize('Welcome to BRIMMESA AI.', 'Sulafat', 'warm and confident');
  assert.equal(said.spoken, 'Welcome to Brimmesa AI.');
  assert.equal(ttsCalls, 1);
  assert.equal(ttsUsage.count, 1);
  assert.equal(speech.parseWav(said.bytes).sampleRate, 24000);
  const again = await voice.synthesize('Welcome to BRIMMESA AI.', 'Sulafat', 'warm and confident');
  assert.equal(again.cached, true);
  assert.equal(ttsCalls, 1);
  ttsUsage = { day: voice.usageNow().day, count: 40 };
  const capped = await voice.synthesize('Another line.', 'Sulafat', 'warm');
  assert.equal(capped.blocked, 'limit');
  assert.equal(ttsCalls, 1);
  const limited = speech.createSpeaker({
    getKey: () => SECRET,
    now: fixedNow,
    readUsage: () => ({ day: '', count: 0 }),
    writeUsage() { throw new Error('429 must not count'); },
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
  });
  assert.equal((await limited.synthesize('Hello.', 'Orus', 'firm')).blocked, 'rate');
  const quiet = speech.createSpeaker({ getKey: () => '', fetchImpl: async () => { throw new Error('no key must not fetch'); } });
  assert.equal((await quiet.synthesize('Hello.', 'Leda', 'playful')).blocked, 'nokey');
  assert.equal(cast.find(c => c.id === 'amara').voice.geminiVoice, 'Sulafat');
  assert.equal(cast.find(c => c.id === 'jasmine').voice.geminiVoice, 'Leda');
  assert.equal(cast.find(c => c.id === 'renee').voice.geminiVoice, 'Despina');
  assert.equal(cast.find(c => c.id === 'marcus').voice.geminiVoice, 'Orus');

  console.log('9) ElevenLabs voices and character timing');
  const plan = speech.alignmentPlan({
    characters: ['H', 'i', ' ', 'B', 'r', 'i', 'm', 'm', 'e', 's', 'a'],
    character_start_times_seconds: [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.48, 0.56, 0.64, 0.72, 0.8],
    character_end_times_seconds: [0.08, 0.16, 0.24, 0.32, 0.4, 0.48, 0.56, 0.64, 0.72, 0.8, 0.9]
  });
  assert(plan.visemes.length > 3);
  assert.equal(plan.vtimes[0], 0);
  assert(plan.words.join(' ').includes('Brimmesa') || plan.words.includes('Brimmesa'));
  assert.equal(speech.pickVoice([], 'amara').name, 'Matilda');
  assert.equal(speech.pickVoice([
    { voice_id: speech.EL_VOICES.amara.voice_id, name: 'Matilda', labels: { gender: 'female' } },
    { voice_id: 'custom', name: 'Ada', labels: { gender: 'female' } }
  ], 'amara').name, 'Matilda');
  assert.equal(speech.pickVoice([{ voice_id: 'custom', name: 'Ada', labels: { gender: 'female' } }], 'amara').voice_id, 'custom');
  assert.equal(speech.pickVoice([{ voice_id: 'man', name: 'Firm', labels: { gender: 'male' } }], 'marcus').voice_id, 'man');
  const mp3 = Buffer.from('not-real-mp3');
  const elCache = new Map();
  let elCalls = 0;
  let elUsage = { character_count: 0, character_limit: 10000, tier: 'free' };
  const el = speech.createEleven({
    getKey: () => 'xi-test',
    readUsage: () => elUsage,
    writeUsage(u) { elUsage = u; },
    cacheGet: async k => elCache.get(k) || null,
    cacheSet: async (k, value) => { elCache.set(k, value); },
    fetchImpl: async (url, req) => {
      elCalls++;
      assert.equal(req.headers['xi-api-key'], 'xi-test');
      assert(!url.includes('xi-test'));
      assert(url.includes('/v1/text-to-speech/'));
      assert(url.includes('/with-timestamps'));
      assert(url.includes('output_format=mp3_22050_32'));
      const body = JSON.parse(req.body);
      assert.equal(body.model_id, 'eleven_flash_v2_5');
      assert.equal(body.text, 'Welcome to Brimmesa AI.');
      assert(url.includes(encodeURIComponent(speech.EL_VOICES.amara.voice_id)));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          audio_base64: mp3.toString('base64'),
          alignment: {
            characters: ['H', 'i'],
            character_start_times_seconds: [0, 0.1],
            character_end_times_seconds: [0.1, 0.2]
          }
        })
      };
    }
  });
  const clip = await el.synthesize('Welcome to BRIMMESA AI.', speech.EL_VOICES.amara.voice_id);
  assert.equal(clip.provider, 'eleven');
  assert.equal(clip.spoken, 'Welcome to Brimmesa AI.');
  assert(clip.plan.visemes.length >= 1);
  assert.equal(elCalls, 1);
  assert.equal(elUsage.character_count, 'Welcome to Brimmesa AI.'.length);
  const cachedClip = await el.synthesize('Welcome to BRIMMESA AI.', speech.EL_VOICES.amara.voice_id);
  assert.equal(cachedClip.cached, true);
  assert.equal(elCalls, 1);
  const busy = speech.createEleven({
    getKey: () => 'xi-test',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
  });
  assert.equal((await busy.synthesize('Hello there.', 'voice')).blocked, 'rate');
  const bare = speech.createEleven({ getKey: () => '', fetchImpl: async () => { throw new Error('no key must not fetch'); } });
  assert.equal((await bare.synthesize('Hello.', 'voice')).blocked, 'nokey');
  const full = speech.createEleven({
    getKey: () => 'xi-test',
    readUsage: () => ({ character_count: 10000, character_limit: 10000 }),
    fetchImpl: async () => { throw new Error('over limit must not fetch'); }
  });
  assert.equal((await full.synthesize('Hello.', 'voice')).blocked, 'limit');
  const listed = speech.createEleven({
    getKey: () => 'xi-test',
    fetchImpl: async (url, req) => {
      assert(url.includes('/v1/voices'));
      assert.equal(req.headers['xi-api-key'], 'xi-test');
      return { ok: true, status: 200, json: async () => ({ voices: [{ voice_id: 'v1', name: 'Sarah', category: 'premade', labels: { gender: 'female' } }] }) };
    }
  });
  const voices = await listed.listVoices();
  assert.equal(voices.voices[0].name, 'Sarah');
  const sub = speech.createEleven({
    getKey: () => 'xi-test',
    fetchImpl: async (url, req) => {
      assert(url.includes('/v1/user/subscription'));
      assert(!url.includes('xi-test'));
      return { ok: true, status: 200, json: async () => ({ tier: 'free', character_count: 120, character_limit: 10000, status: 'free' }) };
    }
  });
  const account = await sub.subscription();
  assert.equal(account.character_limit, 10000);
  assert.equal(account.character_count, 120);
  assert.equal(cast.find(c => c.id === 'jasmine').voice.elevenName, 'Jessica');
  assert.equal(cast.find(c => c.id === 'renee').voice.elevenName, 'Sarah');
  assert.equal(cast.find(c => c.id === 'marcus').voice.elevenName, 'Daniel');

  console.log('10) knowledge library');
  const Lib = require('./library.js');
  const mem = { v: null };
  const lib = Lib.createLibrary({ get: () => mem.v, set: v => { mem.v = v; } });
  const first = lib.add({ coaches: ['marcus'], title: 'Hashing', sourceType: 'notes', text: 'Hashing checks integrity with a fingerprint. Encryption is reversible with a key.' });
  const dup = lib.add({ coaches: ['marcus'], title: 'Hashing', sourceType: 'notes', text: 'Hashing checks integrity with a fingerprint. Encryption is reversible with a key.' });
  assert(dup.duplicate && lib.items().length === 1 && first.item.chunks.length >= 1);
  const hits = lib.search('integrity fingerprint', { coach: 'marcus' });
  assert(hits.length && /integrity/i.test(hits[0].text));
  const timed = Lib.parseTimed('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHashing checks integrity.\n');
  assert(timed.chunks.length === 1 && timed.chunks[0].start === 1);
  const rows = Lib.parseTakeout(JSON.stringify([{ title: 'Watched Security Plus', titleUrl: 'https://www.youtube.com/watch?v=abc', subtitles: [{ name: 'Channel' }], time: '2024-01-02T00:00:00Z' }]));
  assert(rows[0].title === 'Security Plus' && rows[0].channel === 'Channel');
  const merged = lib.mergeInterests(rows.concat(rows));
  assert.equal(merged.added, 1);
  assert.equal(lib.mergeInterests(rows).added, 0);
  const prompt = Lib.retrievalPrompt({ name: 'Marcus', personality: 'Impatient and direct.' }, 'What is hashing?', hits);
  assert(/own words/i.test(prompt) && /verbatim/i.test(prompt) && /Hashing/.test(prompt) && /Cite each source/i.test(prompt));
  assert(hits[0].citeInConversation !== false);
  lib.seedSecurityPlus(content['secplus-701']);
  lib.seedSecurityPlus(content['secplus-701']);
  assert(lib.items().some(it => it.sourceType === 'playlist' && /playlist\?list=/.test(it.url)));
  assert.equal(lib.items().filter(it => String(it.id).indexOf('seed-secplus-') === 0).length, 5);
  const reloaded = Lib.createLibrary({ get: () => mem.v, set: v => { mem.v = v; } });
  assert.equal(reloaded.items().length, lib.items().length);

  console.log('11) communication loop');
  const cia = Lib.challenge('marcus-cia', []);
  assert.equal(Lib.LOOP.length, 6);
  assert.equal(cia.title, 'CIA triad');
  const strong = Lib.rubric('Confidentiality means the wrong people do not see it. Integrity means nobody changed it. Availability means I can open it.', cia, 'explain');
  assert.equal(strong.dims.accuracy, 100);
  assert(strong.dims.confidence >= 80);
  const shaky = Lib.rubric('maybe stuff', cia, 'explain');
  assert(shaky.dims.confidence < 50 && shaky.dims.accuracy < 50);
  assert(/Scores: Clarity/.test(Lib.feedbackText(strong)));
  assert(Lib.challenge('marcus-phish', []).locked);
  assert(!Lib.challenge('marcus-phish', ['marcus-cia']).locked);
  const kept = Lib.readScores('nope', shaky);
  assert.equal(kept.source, 'script');
  const intent = Lib.keywordIntent("Aria, I'd like to talk to Marcus about Security+");
  assert(intent && intent.coachId === 'marcus' && /security/.test(intent.topic) && intent.dest === 'skills');
  assert.equal(Lib.keywordIntent('talk to Amara about my goal').coachId, 'amara');
  assert.equal(Lib.keywordIntent('introduce me to Jasmine').dest, 'relationships');
  assert.equal(Lib.keywordIntent('chat with Renee about small talk').coachId, 'renee');
  assert.equal(Lib.keywordIntent('the spice aisle is busy'), null);
  const manifest = JSON.parse(fs.readFileSync('data/library/manifest.json', 'utf8'));
  const shelf = JSON.parse(fs.readFileSync(manifest.files[0], 'utf8'));
  const admin = Lib.createLibrary({ get: () => null, set: () => {} });
  const imported = admin.importAdmin(shelf.items[0]);
  const repeat = admin.importAdmin(shelf.items[0]);
  assert(!imported.duplicate && repeat.duplicate && imported.item.attribution && imported.item.chunks.length === 1);
  const edited = Object.assign({}, shelf.items[0], { chunks: [{ id: 'c0', text: 'Updated original note.', start: null }] });
  const replaced = admin.importAdmin(edited);
  assert(replaced.updated && replaced.item.chunks[0].text === 'Updated original note.');
  assert(admin.importAdmin(edited).duplicate);
  const amaraFile = manifest.files.find(p => /amara/.test(p));
  const amaraDoc = JSON.parse(fs.readFileSync(amaraFile, 'utf8'));
  const amaraItem = amaraDoc.items[0];
  assert(amaraItem.coaches.indexOf('amara') >= 0 && amaraItem.chunks.length >= 10 && amaraItem.chunks.length <= 25);
  assert(amaraItem.chunks.every(c => Number.isFinite(c.start) && /[?&]t=\d+/.test(c.text) && c.text.length < 400));
  assert(/not a transcript/i.test(amaraItem.attribution));
  assert(!/\b(fuck|shit|bitch|hoe|pimp)\b/i.test(JSON.stringify(amaraItem.chunks)));
  const amaraLib = Lib.createLibrary({ get: () => null, set: () => {} });
  amaraLib.importAdmin(amaraItem);
  const amaraHit = amaraLib.search('magic moment mentor purpose', { coach: 'amara' })[0];
  assert(amaraHit && /youtube\.com/.test(amaraHit.url) && amaraHit.start != null);
  assert.equal(amaraItem.citeInConversation, false);
  assert.equal(amaraHit.citeInConversation, false);
  assert.equal(Lib.citesInConversation({ coaches: ['marcus'] }), true);
  const quietPrompt = Lib.retrievalPrompt({ name: 'Coach Amara', personality: 'Calm and exacting.', styleNote: 'States the standard, then gets warm.' }, 'act or art', [amaraHit]);
  assert(/own coaching/i.test(quietPrompt) && /welcome, explain/i.test(quietPrompt) && !/Cite each source/i.test(quietPrompt) && !/youtube/i.test(quietPrompt) && !/Bosshogg/i.test(quietPrompt));
  assert.equal(Lib.METHOD.map(s => s.id).join(','), 'welcome,explain,demonstrate,invite,coach,encourage');
  const amaraOpen = Lib.methodLine('amara', { topic: 'the magic moment' });
  assert(/Morning walks make my whole day better/.test(amaraOpen) && /kids wake up/.test(amaraOpen) && /skip ahead/i.test(amaraOpen));
  assert(!/one claim, then one reason/i.test(amaraOpen) && !/first claim/i.test(amaraOpen));
  const amaraHard = Lib.methodLine('amara', { experienced: true, topic: 'focus' });
  assert(/skip ahead/i.test(amaraHard) && amaraHard.length < amaraOpen.length);
  assert(/progress/i.test(Lib.methodReply('amara', 'Morning pages steady me because the house is quiet')));
  manifest.files.filter(p => /amara\//.test(p)).forEach(p => {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const item = doc.items[0];
    assert(item.citeInConversation === false && item.chunks.length >= 10 && item.chunks.length <= 25);
    assert(!/\b(fuck|shit|bitch|hoe|pimp)\b/i.test(JSON.stringify(item.chunks)));
    assert(item.chunks.every(c => /[?&]t=\d+/.test(c.text)));
  });

  console.log('7) scoped quiz, matched answer, readable progress');
  const audit = new Engine({ worlds, content, profile: newProfile(), now });
  const sec = audit.activities().find(a => a.id === 'secplus-701');
  const items = content['secplus-701'].items;
  const q6 = items.find(it => it.id === 'q6');
  const q4 = items.find(it => it.id === 'q4');
  audit.activeCoach = 'marcus';
  audit.start(sec);
  audit.s.askedId = 'q6';
  audit.s.order = [q6];
  audit.s.i = 0;
  const mfaGrade = await audit.handle('mfa');
  const mfaText = mfaGrade.map(l => l.text).join(' ');
  assert(/Multifactor authentication/.test(mfaText));
  assert(!/Ransomware/.test(mfaText));
  audit.activeCoach = 'marcus';
  audit.start(sec);
  audit.s.askedId = 'q4';
  audit.s.i = 0;
  audit.openArea({ id: 'mindset', title: 'Mindset & Purpose', intro: 'Welcome in.', reflections: [] });
  assert.equal(audit.mode, 'area');
  assert.equal(audit.act, null);
  assert(audit.lessons['marcus:secplus-701'] && audit.lessons['marcus:secplus-701'].askedId === 'q4');
  const parked = await audit.handle('mfa');
  assert.equal(audit.mode, 'area');
  assert(!/Ransomware/.test(parked.map(l => l.text).join(' ')));
  audit.activeCoach = 'jasmine';
  audit.start(sec);
  audit.exitActivity();
  assert.equal(audit.mode, 'menu');
  assert.equal(audit.act, null);
  const back = await audit.handle('nice to see you');
  assert.equal(audit.mode, 'menu');
  assert(!/Ransomware/.test(back.map(l => l.text).join(' ')) && !/Multifactor authentication:/.test(back.map(l => l.text).join(' ')));
  assert.equal(Lib.matchItem(items, 'what is MFA').id, 'q6');
  assert.equal(Lib.matchItem(items, 'ransomware').id, 'q4');
  assert.notEqual(Lib.matchItem(items, 'what is MFA').explain, q4.explain);
  const named = e.progressSummary();
  assert(!/social\.approach/.test(named) && !/secplus-701/.test(named) && !/comm\.interruptions/.test(named));
  assert(/Grocery spice aisle/.test(named) && /Security\+ SY0-701 lesson/.test(named));
  assert(e.p.history.every(h => !/^(spice-aisle|secplus-701|interruptions)$/.test(h.activity)));
  assert(e.p.history.some(h => h.activity === 'Grocery spice aisle'));
  const amaraWhy = Lib.methodLine('amara', { topic: 'the magic moment' });
  assert(/creator/i.test(amaraWhy) && /meeting/i.test(amaraWhy) && /Morning walks/.test(amaraWhy));
  assert(!/^A claim/.test(amaraWhy));
  const fromPitch = Lib.methodLine('amara', { heard: 'I have a pitch for a client' });
  assert(/three hours a week/.test(fromPitch) && /skip ahead/i.test(fromPitch));
  ['jasmine', 'renee', 'marcus'].forEach(id => {
    const taught = Lib.methodLine(id, {});
    assert(/why/i.test(taught) && /skip ahead/i.test(taught));
  });
  const Ctx = require('./context.js');
  const turkey = Ctx.localHolidays(2026).find(h => h.name === 'Thanksgiving');
  assert.equal(turkey.date, '2026-11-26');
  assert.equal(Ctx.localHolidays(2026).find(h => h.name === 'Christmas').date, '2026-12-25');
  assert.equal(Ctx.clockFrom(Date.parse('2026-11-26T18:30:00Z')).tag, 'LIVE');
  assert.equal(Ctx.skyText(3), 'overcast');
  assert(/skill drill/i.test(Ctx.affairsLine(null)) && /will not invent/i.test(Ctx.affairsLine(null)));
  const sourced = Ctx.affairsLine({ source: 'Wikipedia', published: '2026-10-16', summary: 'A council vote was reported.', url: 'https://en.wikipedia.org/wiki/Example', kind: 'reporting' });
  assert(/Reporting/.test(sourced) && /Wikipedia/.test(sourced) && /2026-10-16/.test(sourced) && /wikipedia.org/.test(sourced));
  assert(!/weekend parking/.test(sourced));
  const unknownPrompt = Ctx.promptFrom({ clock: Ctx.clockFrom(Date.parse('2026-10-16T15:00:00Z')), weather: { tag: 'UNKNOWN', reason: 'no location chosen' }, holidays: { tag: 'UNKNOWN' }, news: { tag: 'UNKNOWN', reason: 'not loaded' } });
  assert(/Never invent/.test(unknownPrompt) && /WEATHER UNKNOWN/.test(unknownPrompt) && /NEWS UNKNOWN/.test(unknownPrompt));
  const ctxMem = { v: '' };
  let fetches = 0;
  const live = Ctx.createContext({
    storage: { get: () => ctxMem.v, set: v => { ctxMem.v = v; } },
    now: () => Date.parse('2026-10-16T18:00:00Z'),
    fetch: async (url) => {
      fetches++;
      const u = String(url);
      if (u.indexOf('forecast') >= 0) return { ok: true, json: async () => ({ current: { temperature_2m: 70.2, weather_code: 2 } }) };
      if (u.indexOf('geocoding') >= 0) return { ok: true, json: async () => ({ results: [{ name: 'Austin', admin1: 'Texas', latitude: 30.27, longitude: -97.74 }] }) };
      if (u.indexOf('nager') >= 0) return { ok: false, json: async () => [] };
      if (u.indexOf('wikipedia') >= 0) return { ok: true, json: async () => ({ news: [{ story: '<!--Oct 16-->A council <b>vote</b> was reported.', links: [{ content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Example' } } }] }] }) };
      return { ok: false, json: async () => ({}) };
    }
  });
  assert.equal(live.snapshot().weather.tag, 'UNKNOWN');
  assert(/won't guess/.test(live.answer('what is the weather')));
  live.decline();
  assert(/don't have the weather/.test(live.answer('what is the weather')));
  await live.ensure({ weather: true, holidays: false, news: false });
  assert.equal(fetches, 0);
  ctxMem.v = '';
  await live.useCity('Austin');
  const snap = live.snapshot();
  assert.equal(snap.weather.tag, 'LIVE');
  assert(/Austin/.test(snap.weather.summary) && /Open-Meteo/.test(live.answer('what is the weather', snap)));
  const afterCity = fetches;
  await live.ensure({ weather: true, holidays: false, news: true });
  const story = live.leadStory();
  assert(story && story.kind === 'reporting' && /Example/.test(story.url) && /council vote/i.test(story.summary));
  assert(/Reporting/.test(live.affairsLine(story)));
  const afterNews = fetches;
  await live.ensure({ weather: true, holidays: false, news: true });
  assert.equal(fetches, afterNews);
  assert(afterCity < afterNews);
  ['amara', 'jasmine', 'renee', 'marcus'].forEach(id => {
    const line = Lib.methodLine(id, {});
    assert(/skip ahead/i.test(line) && line.length > 40, id);
  });
  assert(/actually asked/i.test(quietPrompt));

  const world = require('./walk.js');
  const walks = require('./data/walks.json');
  const destDoc = require('./data/destinations.json');
  const byId = {};
  destDoc.destinations.forEach(d => { byId[d.id] = d; });
  assert(world.depthAt(16) < world.depthAt(52) && world.depthAt(52) < world.depthAt(76));
  assert(world.spritePx(50, 2.2, 78) < world.spritePx(50, 1, 78));
  assert(world.jawAmount('aa') > world.jawAmount('PP') && world.jawAmount('') === 0);
  const cam = world.cameraTarget(50, 50, 2, 360, 270);
  const centerX = (50 / 100) * 360 * cam.scale + cam.tx;
  assert(Math.abs(centerX - 180) < 1);
  ['amara', 'marcus', 'jasmine', 'renee'].forEach(id => {
    const plan = walks.coaches[id];
    const dest = byId[plan.dest];
    assert(plan.waypoints.length >= 4, id);
    const start = plan.waypoints[0];
    const end = plan.waypoints[plan.waypoints.length - 1];
    assert(Math.hypot(start[0] - 58, start[1] - 52) < 2, id + ' start');
    assert(Math.hypot(end[0] - dest.x, end[1] - dest.y) < 12, id + ' end');
    assert(plan.figure && plan.figure.src, id + ' figure');
  });
  assert(walks.coaches.amara.dest === 'mindset' && walks.coaches.jasmine.dest === 'relationships');
  assert(walks.coaches.amara.figure.kind === 'sheet' && walks.coaches.jasmine.figure.kind === 'portrait');

  console.log('\nALL TESTS PASSED');
})().catch(err => { console.error('FAIL', err); process.exit(1); });
