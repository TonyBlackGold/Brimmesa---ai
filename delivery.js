// Scene goal rubric and an Orai-style delivery card. No confidence or emotion scores.
(function (root) {
  const FILLERS = ['um', 'uh', 'er', 'ah', 'like', 'you know', 'sort of', 'kind of', 'basically', 'actually', 'literally'];

  function criteriaFor(scene) {
    const custom = scene && scene.goalRubric && scene.goalRubric.criteria;
    if (custom && custom.length) return { goal: scene.goalRubric.goal || scene.setting || '', criteria: custom };
    const criteria = ((scene && scene.rubric) || []).map(r => ({ id: r.id, label: r.label, words: [] }));
    return { goal: (scene && (scene.setting || scene.feedbackLabel)) || '', criteria: criteria };
  }
  function evidenceFor(text, words) {
    const src = String(text || '').replace(/\s+/g, ' ').trim();
    const low = src.toLowerCase();
    for (let i = 0; i < (words || []).length; i++) {
      const w = String(words[i] || '').toLowerCase();
      if (!w) continue;
      const at = low.indexOf(w);
      if (at >= 0) return src.slice(Math.max(0, at - 24), at + w.length + 36).trim().slice(0, 80);
    }
    return '';
  }
  function goalEstimate(text, scene, hit) {
    const spec = criteriaFor(scene);
    const said = String(text || '');
    const wordsN = said.split(/\s+/).filter(Boolean).length;
    const rows = spec.criteria.map(c => {
      const keys = c.words || [];
      const ev = evidenceFor(said, keys);
      const hits = keys.filter(w => said.toLowerCase().indexOf(String(w).toLowerCase()) >= 0).length;
      const signaled = !!(hit && hit[c.id]);
      let score = 2;
      if (hits >= 2) score = 5;
      else if (ev || signaled) score = 4;
      else if (wordsN > 14) score = 3;
      else if (wordsN < 4) score = 1;
      return { id: c.id, label: c.label, score: score, evidence: ev };
    });
    if (!rows.length) {
      return { source: 'estimate', goal: spec.goal, criteria: [], fix: 'Say one concrete detail from the scene.', score100: 40 };
    }
    const low = rows.slice().sort((a, b) => a.score - b.score)[0];
    const avg = rows.reduce((sum, r) => sum + r.score, 0) / rows.length;
    return {
      source: 'estimate',
      goal: spec.goal,
      criteria: rows,
      fix: 'Next time, make ' + String(low.label || 'the point').toLowerCase() + ' explicit in one sentence.',
      score100: Math.round(avg * 20)
    };
  }
  function readGoal(raw, scene) {
    const spec = criteriaFor(scene);
    let j = null;
    const clean = String(raw || '').replace(/```json|```/g, '').trim();
    try { j = JSON.parse(clean); } catch (e) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) { try { j = JSON.parse(m[0]); } catch (e2) { j = null; } }
    }
    if (!j || !Array.isArray(j.criteria) || !spec.criteria.length) return null;
    const rows = [];
    for (let i = 0; i < spec.criteria.length; i++) {
      const c = spec.criteria[i];
      const hit = j.criteria.find(x => x && String(x.id) === String(c.id));
      if (!hit) return null;
      const n = Math.round(Number(hit.score));
      if (!Number.isFinite(n)) return null;
      rows.push({
        id: c.id,
        label: c.label,
        score: Math.max(1, Math.min(5, n)),
        evidence: String(hit.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 80)
      });
    }
    const fix = String(j.fix || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!fix) return null;
    const avg = rows.reduce((sum, r) => sum + r.score, 0) / rows.length;
    return { source: 'gemini', goal: spec.goal, criteria: rows, fix: fix, score100: Math.round(avg * 20) };
  }
  function formatGoal(goal) {
    if (!goal) return '';
    const bits = (goal.criteria || []).map(c => c.label + ' ' + c.score + '/5' + (c.evidence ? ' ("' + c.evidence + '")' : '')).join('. ');
    const tag = goal.source === 'estimate' ? ' Estimate, not a model score.' : '';
    const fix = String(goal.fix || '').replace(/[. ]+$/, '');
    return 'Goal rubric. ' + (bits || 'No criteria.') + ' Fix: ' + fix + '.' + tag;
  }
  function countFillers(text) {
    const t = String(text || '').toLowerCase();
    let n = 0;
    const found = [];
    FILLERS.forEach(f => {
      const re = new RegExp('\\b' + f.replace(/\s+/g, '\\s+') + '\\b', 'g');
      const m = t.match(re);
      if (m && m.length) { n += m.length; found.push(f); }
    });
    return { n: n, found: found };
  }
  function deliveryCard(utterances, text) {
    const list = Array.isArray(utterances) ? utterances : [];
    const said = String(text || list.map(u => (u && u.text) || '').join(' '));
    const fill = countFillers(said);
    const words = said.split(/\s+/).filter(Boolean).length;
    const times = list.filter(u => u && u.start != null && u.end != null && Number(u.end) >= Number(u.start));
    let wpm = null;
    const pauses = [];
    if (times.length) {
      const start = Math.min.apply(null, times.map(u => Number(u.start)));
      const end = Math.max.apply(null, times.map(u => Number(u.end)));
      const minutes = (end - start) / 60000;
      if (end - start >= 1000 && words) wpm = Math.round(words / minutes);
      const ordered = times.slice().sort((a, b) => Number(a.start) - Number(b.start));
      for (let i = 1; i < ordered.length; i++) {
        const gap = Number(ordered[i].start) - Number(ordered[i - 1].end);
        if (gap >= 600) pauses.push(gap);
      }
      ordered.forEach(u => {
        (u.gaps || []).forEach(g => { if (Number(g) >= 600) pauses.push(Number(g)); });
      });
    }
    const longest = pauses.length ? Math.max.apply(null, pauses) : 0;
    let tip = 'Say the next line in one breath, then stop.';
    if (fill.n >= 3) tip = 'Cut one filler word and leave a short pause instead.';
    else if (wpm != null && wpm > 180) tip = 'Slow the next sentence by one breath.';
    else if (wpm != null && wpm < 90) tip = 'Use one shorter sentence so the pace stays easy to follow.';
    else if (longest >= 1500) tip = 'Keep the pause, then finish the point in the next sentence.';
    return { fillers: fill.n, fillerWords: fill.found, wpm: wpm, pauseCount: pauses.length, pauseMs: longest, tip: tip };
  }
  function formatCard(card) {
    if (!card) return '';
    const pace = card.wpm == null ? 'Pace was not measured, because there were no timestamps.' : (card.wpm + ' words per minute.');
    const pauses = card.pauseCount ? (card.pauseCount + ' pauses, longest ' + card.pauseMs + ' ms.') : 'No measurable pause.';
    const tip = String(card.tip || '').replace(/[. ]+$/, '');
    return 'Scorecard. Filler words: ' + card.fillers + '. ' + pace + ' ' + pauses + ' Tip: ' + tip + '.';
  }

  const api = { FILLERS, criteriaFor, goalEstimate, readGoal, formatGoal, countFillers, deliveryCard, formatCard };
  if (typeof module !== 'undefined') module.exports = api;
  else root.BrimDelivery = api;
})(typeof window !== 'undefined' ? window : globalThis);
