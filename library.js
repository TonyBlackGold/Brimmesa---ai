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
    return {
      add: add,
      remove: remove,
      search: search,
      items: () => state.items.slice(),
      interests: () => state.interests.slice(),
      mergeInterests: mergeInterests,
      seedSecurityPlus: seedSecurityPlus,
      MESSER_PLAYLIST: MESSER_PLAYLIST
    };
  }

  const api = { createLibrary, hash, chunkText, parseTimed, parseTakeout, youtube, retrievalPrompt, fmtTime };
  if (typeof module !== 'undefined') module.exports = api; else root.BrimLibrary = api;
})(this);
