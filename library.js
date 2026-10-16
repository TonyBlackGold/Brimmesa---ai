// On-device knowledge library. BM25 over chunks. No network. No embeddings.
(function (root) {
  const MESSER_PLAYLIST = 'https://www.youtube.com/playlist?list=PLG49S3nxzAnl4QDVqK-hOnoqcSKEIDDuv';

  function hash(s) {
    let h = 5381;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(16);
  }
  function tokens(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9+#.\- ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  }
  function fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }
  function clock(stamp) {
    const m = String(stamp || '').match(/(\d+):(\d+):(\d+)[.,](\d+)/);
    if (!m) return null;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  }
  function chunkText(text, size) {
    const parts = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
    const out = [];
    let buf = '';
    parts.forEach(p => {
      if ((buf + ' ' + p).trim().length > (size || 480) && buf) { out.push(buf.trim()); buf = p; }
      else buf = (buf ? buf + ' ' : '') + p;
    });
    if (buf.trim()) out.push(buf.trim());
    return out.map((t, i) => ({ id: 'c' + i, text: t, start: null }));
  }
  function parseTimed(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '');
    const cues = [];
    const blocks = text.split(/\n{2,}/);
    blocks.forEach(block => {
      const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
      const time = lines.find(l => /-->/.test(l));
      if (!time) return;
      const start = clock(time.split('-->')[0]);
      const body = lines.filter(l => l !== time && !/^\d+$/.test(l) && l !== 'WEBVTT' && !/^NOTE/.test(l) && !/^Kind:|^Language:/.test(l)).join(' ');
      if (body) cues.push({ start: start, text: body });
    });
    if (!cues.length) return { cues: [], chunks: chunkText(text) };
    const chunks = [];
    let buf = '', start = cues[0].start;
    cues.forEach(c => {
      if ((buf + ' ' + c.text).trim().length > 480 && buf) {
        chunks.push({ id: 'c' + chunks.length, text: buf.trim(), start: start });
        buf = c.text; start = c.start;
      } else {
        if (!buf) start = c.start;
        buf = (buf ? buf + ' ' : '') + c.text;
      }
    });
    if (buf.trim()) chunks.push({ id: 'c' + chunks.length, text: buf.trim(), start: start });
    return { cues: cues, chunks: chunks };
  }
  function stripWatched(title) {
    return String(title || '').replace(/^Watched\s+/i, '').trim();
  }
  function parseTakeout(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    if (text[0] === '{' || text[0] === '[') {
      let data;
      try { data = JSON.parse(text); } catch (e) { return []; }
      const rows = Array.isArray(data) ? data : (data && (data.items || data.videos)) || [];
      return rows.map(row => ({
        title: stripWatched(row.title || row.name),
        url: row.titleUrl || row.url || '',
        channel: (row.subtitles && row.subtitles[0] && row.subtitles[0].name) || row.channel || '',
        at: row.time || row.date || ''
      })).filter(r => r.title);
    }
    const out = [];
    const re = /<a[^>]+href="(https?:\/\/www\.youtube\.com\/watch\?[^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = re.exec(text))) out.push({ title: stripWatched(m[2]), url: m[1].replace(/&amp;/g, '&'), channel: '', at: '' });
    return out;
  }
  function youtube(url) {
    const u = String(url || '').trim();
    const video = u.match(/[?&]v=([a-zA-Z0-9_-]{6,})/) || u.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
    const list = u.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return { url: u, videoId: video && video[1], playlistId: list && list[1], sourceType: list && !video ? 'playlist' : 'youtube' };
  }
  function retrievalPrompt(coach, query, hits) {
    const who = coach || {};
    const notes = (hits || []).map(h => {
      const when = h.start == null ? '' : ' timestamp ' + fmtTime(h.start);
      const link = h.url ? ' ' + h.url : '';
      return '- ' + (h.title || 'Untitled') + link + when + '\n  note: ' + String(h.text || '').slice(0, 220);
    }).join('\n');
    return [
      'You are ' + (who.name || 'the coach') + '.',
      'Personality, separate from the notes: ' + (who.personality || ''),
      'Explain in your own words and your own slang. Never paste long verbatim source text. A short phrase at most.',
      'Cite each source you use as its title, link, and timestamp when you have them.',
      'Write the brand as Brimmesa, mixed case. One to three spoken sentences. No markdown.',
      'Notes:\n' + (notes || '(none)'),
      'Question: ' + String(query || '')
    ].join('\n');
  }

  function createLibrary(storage) {
    const blank = { version: 1, items: [], interests: [] };
    let state = blank;
    try {
      const saved = storage && storage.get ? JSON.parse(storage.get() || 'null') : null;
      if (saved && Array.isArray(saved.items)) state = Object.assign(blank, saved);
    } catch (e) { state = blank; }
    function persist() { if (storage && storage.set) storage.set(JSON.stringify(state)); }
    function findHash(h) { return state.items.find(it => it.hash === h); }
    function add(input) {
      const src = input || {};
      const coaches = src.coaches || (src.coach ? [src.coach] : ['shared']);
      const key = src.hashKey || (src.url ? 'url:' + String(src.url).trim() : 'text:' + (src.title || '') + '|' + (src.text || ''));
      const digest = hash(key);
      const prior = findHash(digest);
      if (prior) return { item: prior, duplicate: true };
      const timed = src.chunks ? null : (src.timed ? parseTimed(src.text) : null);
      const chunks = src.chunks || (timed ? timed.chunks : chunkText(src.text || src.title || ''));
      const item = {
        id: src.id || ('lib-' + digest),
        coaches: coaches,
        title: src.title || 'Untitled',
        sourceType: src.sourceType || 'notes',
        url: src.url || '',
        channel: src.channel || '',
        timestamps: src.timestamps || (timed ? timed.cues : []),
        chunks: chunks,
        tags: src.tags || [],
        attribution: src.attribution || '',
        addedAt: src.addedAt || Date.now(),
        hash: digest
      };
      state.items.push(item);
      persist();
      return { item: item, duplicate: false };
    }
    function remove(id) {
      state.items = state.items.filter(it => it.id !== id);
      persist();
    }
    function search(query, opts) {
      const coach = opts && opts.coach;
      const limit = (opts && opts.limit) || 4;
      const docs = [];
      state.items.forEach(item => {
        const coaches = item.coaches || [];
        if (coach && coach !== 'all') {
          const sharedOk = coach !== 'shared' && coaches.indexOf('shared') >= 0;
          if (coaches.indexOf(coach) < 0 && !sharedOk) return;
        }
        (item.chunks || []).forEach(ch => docs.push({
          item: item,
          ch: ch,
          tokens: tokens((ch.text || '') + ' ' + item.title + ' ' + (item.tags || []).join(' '))
        }));
      });
      const q = tokens(query);
      if (!q.length || !docs.length) return [];
      const avg = docs.reduce((a, d) => a + d.tokens.length, 0) / docs.length || 1;
      const df = {};
      docs.forEach(d => {
        const seen = {};
        d.tokens.forEach(t => { if (!seen[t]) { df[t] = (df[t] || 0) + 1; seen[t] = 1; } });
      });
      const N = docs.length;
      const scored = docs.map(d => {
        const tf = {};
        d.tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
        let score = 0;
        q.forEach(term => {
          const f = tf[term] || 0;
          if (!f) return;
          const idf = Math.log(1 + (N - (df[term] || 0) + 0.5) / ((df[term] || 0) + 0.5));
          const k = 1.2, b = 0.75;
          score += idf * (f * (k + 1)) / (f + k * (1 - b + b * d.tokens.length / avg));
        });
        return {
          score: score,
          text: d.ch.text,
          title: d.item.title,
          url: d.item.url,
          start: d.ch.start,
          sourceType: d.item.sourceType,
          coaches: d.item.coaches,
          id: d.item.id
        };
      }).filter(d => d.score > 0).sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    }
    function mergeInterests(rows) {
      let added = 0;
      (rows || []).forEach(row => {
        if (!row || !row.title) return;
        const key = (row.url || (row.title + '|' + (row.channel || ''))).toLowerCase();
        if (state.interests.some(r => ((r.url || (r.title + '|' + (r.channel || ''))).toLowerCase()) === key)) return;
        state.interests.push({ title: row.title, url: row.url || '', channel: row.channel || '', at: row.at || '', account: row.account || '' });
        added++;
      });
      state.interests.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      persist();
      return { added: added, total: state.interests.length };
    }
    function seedSecurityPlus(curriculum) {
      if (!curriculum) return;
      (curriculum.domains || []).forEach(dom => {
        const lines = (curriculum.items || []).filter(it => it.domain === dom.id);
        add({
          id: 'seed-secplus-' + dom.id,
          coaches: ['marcus'],
          title: (curriculum.examCode || 'SY0-701') + ' ' + dom.name + ' (Brimmesa original outline)',
          sourceType: 'notes',
          url: '',
          channel: 'Brimmesa',
          tags: ['security+', 'sy0-701', dom.id],
          text: lines.map(it => it.teach).join(' '),
          hashKey: 'seed:secplus:' + dom.id
        });
      });
      add({
        id: 'seed-messer-sy0701',
        coaches: ['marcus'],
        title: 'Professor Messer Security+ SY0-701 course (reference playlist only)',
        sourceType: 'playlist',
        url: MESSER_PLAYLIST,
        channel: 'Professor Messer',
        tags: ['security+', 'reference'],
        text: 'Reference link only. Teach from the Brimmesa outline, not from a copied script.',
        hashKey: 'seed:messer:sy0-701'
      });
    }
    function contentHash(src, chunks) {
      return hash(JSON.stringify({
        title: src.title || '',
        url: src.url || '',
        sourceType: src.sourceType || '',
        chunks: (chunks || []).map(c => [c.start == null ? null : c.start, c.text || ''])
      }));
    }
    function importAdmin(input) {
      const src = input || {};
      const chunks = src.chunks && src.chunks.length ? src.chunks : chunkText(src.text || src.title || '');
      const digestContent = contentHash(src, chunks);
      const key = src.hashKey || (src.url ? 'url:' + String(src.url).trim() : 'text:' + (src.title || '') + '|' + (src.text || ''));
      const digest = hash(key);
      const byKey = state.items.find(it => it.hash === digest);
      const byContent = state.items.find(it => it.contentHash === digestContent);
      if ((byKey && byKey.contentHash === digestContent) || byContent) return { item: byKey || byContent, duplicate: true };
      if (byKey) {
        byKey.title = src.title || byKey.title;
        byKey.sourceType = src.sourceType || byKey.sourceType;
        byKey.url = src.url || '';
        byKey.channel = src.channel || '';
        byKey.timestamps = src.timestamps || [];
        byKey.chunks = chunks;
        byKey.tags = src.tags || [];
        byKey.attribution = src.attribution || '';
        byKey.contentHash = digestContent;
        persist();
        return { item: byKey, updated: true, duplicate: false };
      }
      const saved = add(Object.assign({}, src, { chunks: chunks }));
      if (saved.item) {
        saved.item.contentHash = digestContent;
        persist();
      }
      return saved;
    }
    return {
      add: add,
      importAdmin: importAdmin,
      remove: remove,
      search: search,
      items: () => state.items.slice(),
      interests: () => state.interests.slice(),
      mergeInterests: mergeInterests,
      seedSecurityPlus: seedSecurityPlus,
      MESSER_PLAYLIST: MESSER_PLAYLIST
    };
  }

  const LOOP = [
    { id: 'learn', label: 'Learn' },
    { id: 'explain', label: 'Explain' },
    { id: 'practice', label: 'Practice' },
    { id: 'communicate', label: 'Communicate' },
    { id: 'improve', label: 'Improve' },
    { id: 'advance', label: 'Advance' }
  ];
  const DIMENSIONS = [
    { id: 'clarity', label: 'Clarity' },
    { id: 'accuracy', label: 'Accuracy' },
    { id: 'organization', label: 'Organization' },
    { id: 'vocabulary', label: 'Vocabulary' },
    { id: 'delivery', label: 'Delivery' },
    { id: 'confidence', label: 'Confidence' }
  ];
  const TIPS = {
    clarity: 'One idea, then stop.',
    accuracy: 'Name the real idea, not a nearby one.',
    organization: 'First the point, then the reason.',
    vocabulary: 'Use the word a listener could repeat.',
    delivery: 'Say it in a breath or two.',
    confidence: 'Start on the point. Skip the apology.'
  };
  const CHALLENGES = [
    {
      id: 'marcus-cia',
      coach: 'marcus',
      title: 'CIA triad',
      concept: 'the CIA triad',
      achievement: 'Said it twice',
      unlocks: 'marcus-phish',
      keywords: ['confidentiality', 'integrity', 'availability'],
      practiceKeywords: ['availability'],
      learn: "Thirty seconds. CIA is not the spies. Confidentiality means the wrong people don't see it. Integrity means nobody quietly changed it. Availability means you can open it when the lights flicker. A hospital chart goes dark in a power cut? That's availability. Ha. Now you have to say it.",
      explain: 'Your turn. Explain the CIA triad back to me. Voice is better. Tap to talk.',
      practice: "Don't recite the poster. A clinic's charts vanish during an outage. Nothing was leaked. Which piece of CIA broke?",
      practiceFix: 'Availability. The chart was unreachable, not stolen and not edited.',
      surprise: 'Plot twist. The next room does not want the textbook.',
      audiences: [
        { id: 'friend', label: 'a friend', cue: 'No jargon. One story.' },
        { id: 'interviewer', label: 'an interviewer', cue: 'A short example, what changed.' },
        { id: 'classroom', label: 'a classroom', cue: 'Teach it so they could repeat it.' },
        { id: 'professionals', label: 'professionals', cue: 'Plain and specific.' }
      ]
    },
    {
      id: 'marcus-phish',
      coach: 'marcus',
      title: 'Phishing',
      concept: 'phishing',
      requires: 'marcus-cia',
      achievement: 'Caught the fake',
      keywords: ['phish', 'fake', 'link', 'spear'],
      practiceKeywords: ['spear'],
      learn: "Phishing is a fake message that wants a click. Spear phishing aims at one person, using their real names. If the whole finance team gets a fake invoice from their boss, that's the spear. Funny until the wire goes out.",
      explain: 'Explain phishing back to me, including how spear phishing is different. Tap to talk.',
      practice: 'Only the finance team gets a fake invoice that uses their manager\'s name. What is that called?',
      practiceFix: 'Spear phishing. One target, familiar names.',
      surprise: 'New room. They have already almost clicked.',
      audiences: [
        { id: 'friend', label: 'a friend', cue: 'Tell them what to look for before they tap.' },
        { id: 'interviewer', label: 'an interviewer', cue: 'Say what you would do first.' },
        { id: 'classroom', label: 'a classroom', cue: 'Give them one check they can remember.' },
        { id: 'professionals', label: 'professionals', cue: 'Skip the scare. Say the control.' }
      ]
    }
  ];

  function challenge(id, done) {
    const spec = CHALLENGES.find(c => c.id === id);
    if (!spec) return null;
    const have = done || [];
    if (spec.requires && have.indexOf(spec.requires) < 0) return { locked: true, id: spec.id, requires: spec.requires, title: spec.title };
    return spec;
  }
  function rubric(text, spec, step) {
    const t = String(text || '').toLowerCase();
    const words = t.split(/\s+/).filter(Boolean);
    const keys = step === 'practice' ? (spec.practiceKeywords || []) : (spec.keywords || []);
    const hit = keys.filter(k => t.includes(k)).length;
    const accuracy = keys.length ? Math.round(100 * hit / keys.length) : 70;
    const clarity = words.length >= 8 && words.length <= 60 ? 100 : words.length >= 4 ? 60 : 25;
    const organization = /\b(first|then|because|so|means|that's|thats)\b/.test(t) || (t.match(/[.!?]/g) || []).length >= 1 ? 80 : 40;
    const vocabulary = hit > 0 ? 100 : 30;
    const delivery = words.length >= 6 && words.length <= 45 ? 90 : words.length > 45 ? 55 : 35;
    const confidence = /\b(maybe|sorry|i don't know|i dont know|not sure|kinda|kind of)\b/.test(t) ? 35 : 85;
    const dims = { clarity: clarity, accuracy: accuracy, organization: organization, vocabulary: vocabulary, delivery: delivery, confidence: confidence };
    const overall = Math.round(DIMENSIONS.reduce((a, d) => a + dims[d.id], 0) / DIMENSIONS.length);
    const low = DIMENSIONS.slice().sort((a, b) => dims[a.id] - dims[b.id])[0];
    return { dims: dims, overall: overall, tip: TIPS[low.id], low: low.label, source: 'script' };
  }
  function feedbackText(score) {
    const bits = DIMENSIONS.map(d => d.label + ' ' + score.dims[d.id]).join(', ');
    return 'Scores: ' + bits + '. ' + (score.tip || '');
  }
  function evalPrompt(spec, step, text, audience) {
    const room = audience ? audience.label : 'Marcus';
    return [
      'Score this spoken explanation. Return JSON only.',
      'Fields: clarity, accuracy, organization, vocabulary, delivery, confidence, tip.',
      'Each score is an integer from 0 to 100. tip is one short sentence.',
      'Concept: ' + spec.concept + '. Step: ' + step + '. Audience: ' + room + '.',
      'Accuracy means the idea matches ' + (spec.keywords || []).join(', ') + '.',
      'Do not rewrite their answer. Write the brand as Brimmesa.',
      'They said: ' + String(text || '').slice(0, 500)
    ].join('\n');
  }
  function readScores(raw, fallback) {
    let j = null;
    const clean = String(raw || '').replace(/```json|```/g, '').trim();
    try { j = JSON.parse(clean); } catch (e) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) { try { j = JSON.parse(m[0]); } catch (e2) { j = null; } }
    }
    if (!j) return fallback;
    const dims = {};
    for (let i = 0; i < DIMENSIONS.length; i++) {
      const n = Number(j[DIMENSIONS[i].id]);
      if (!Number.isFinite(n)) return fallback;
      dims[DIMENSIONS[i].id] = Math.max(0, Math.min(100, Math.round(n)));
    }
    const overall = Math.round(DIMENSIONS.reduce((a, d) => a + dims[d.id], 0) / DIMENSIONS.length);
    return { dims: dims, overall: overall, tip: String(j.tip || fallback.tip).slice(0, 140), low: fallback.low, source: 'gemini' };
  }

  const HOSTS = [
    { id: 'marcus', place: 'the Cybersecurity Academy', dest: 'skills', line: "Absolutely! Marcus is over at the Cybersecurity Academy. Come on, I'll introduce you." },
    { id: 'amara', place: 'Mindset and Purpose', dest: 'mindset', line: "Absolutely! Amara is at Mindset and Purpose. Come on, I'll introduce you." },
    { id: 'jasmine', place: 'Relationships and Dating', dest: 'relationships', line: "Absolutely! Jasmine is over in Relationships and Dating. Come on, I'll introduce you." },
    { id: 'renee', place: 'Lifestyle and Social Skills', dest: 'lifestyle', line: "Absolutely! Renee is over in Lifestyle and Social Skills. Come on, I'll introduce you." }
  ];
  function keywordIntent(text) {
    const t = String(text || '').toLowerCase();
    const coach = HOSTS.find(h => t.indexOf(h.id) >= 0);
    if (!coach) return null;
    if (!/\b(talk|speak|meet|see|introduce|chat|with)\b/.test(t)) return null;
    const about = t.match(/\babout\s+([^.?!]+)/);
    return { coachId: coach.id, topic: about ? about[1].trim() : '', place: coach.place, dest: coach.dest, line: coach.line };
  }

  const api = { createLibrary, hash, chunkText, parseTimed, parseTakeout, youtube, retrievalPrompt, fmtTime, LOOP, DIMENSIONS, challenge, rubric, feedbackText, evalPrompt, readScores, keywordIntent, HOSTS };
  if (typeof module !== 'undefined') module.exports = api; else root.BrimLibrary = api;
})(this);
