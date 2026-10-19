// Simulated Test A (five-minute Aria talk) and Test C (Marcus verbal check).
// No network. Latency marks are from the stub clock, not a live model.
const Gym = require('./gym.js');
const Delivery = require('./delivery.js');
const { Engine, newProfile } = require('./engine.js');

function scriptA() {
  return [
    { speaker: 'user', text: 'I freeze before client meetings and I want to sound steady' },
    { speaker: 'aria', text: 'We can stay on client meetings. Tell me the room.' },
    { speaker: 'user', text: 'It is a small room and my manager asks for the update first' },
    { speaker: 'aria', text: 'Start with the update in one sentence, then the reason.' },
    { speaker: 'user', text: 'The update is that the pilot saved three hours, because the team stopped copying numbers' },
    { speaker: 'aria', text: 'That is a point someone can repeat. Say it once more, shorter.' },
    { speaker: 'user', text: 'The pilot saves three hours a week because the copying stopped' },
    { speaker: 'aria', text: 'Good. What do you want to practice if they interrupt?' },
    { speaker: 'user', text: 'I want to finish the sentence and then take their question' },
    { speaker: 'aria', text: 'Try that line out loud.' },
    { speaker: 'user', text: 'Let me finish this point, then I will take the question' },
    { speaker: 'aria', text: 'We are still on client meetings. Where were we is a fair ask.' }
  ];
}

function runA(now) {
  const clock = typeof now === 'function' ? now : (() => 0);
  const marks = [];
  let profile = Gym.blankProfile();
  const lines = scriptA();
  const origin = clock();
  lines.forEach((line, i) => {
    const at = origin + i * 30000;
    if (line.speaker === 'user') marks.push({ stage: 'stt-end', t: at, note: 'stub recognition' });
    profile = Gym.noteTurn(profile, line);
    marks.push({ stage: 'llm-complete', t: at + 20, note: 'stub, no key; generateContent is not called' });
    marks.push({ stage: 'tts-start', t: at + 35, note: 'stub speech' });
  });
  const span = (lines.length - 1) * 30000;
  const back = Gym.noteTurn(profile, { speaker: 'user', text: 'where were we' });
  return { marks: marks, profile: back, span: span, opener: 'client meetings' };
}

function runC(worlds, content, now) {
  const eng = new Engine({ worlds: worlds, content: content, profile: newProfile(), now: now || (() => Date.now()) });
  const marks = [];
  const t0 = (now || Date.now)();
  marks.push({ stage: 'stt-end', t: t0, note: 'stub, learner asked for Security+' });
  const openP = eng.handle('security plus');
  return openP.then(open => {
    marks.push({ stage: 'llm-complete', t: t0 + 5, note: 'scripted engine, no key' });
    marks.push({ stage: 'tts-start', t: t0 + 8, note: 'stub speech' });
    const first = eng.s && eng.s.order && eng.s.order[0];
    const taught = open.map(l => l.text).join(' ');
    const answer = (first && first.accept && first.accept[0]) || 'mfa';
    const saidAt = t0 + 4000;
    eng._heard = { start: saidAt - 1800, end: saidAt };
    marks.push({ stage: 'stt-end', t: saidAt, note: 'stub answer' });
    return eng.handle(answer).then(next => {
      marks.push({ stage: 'llm-complete', t: saidAt + 5, note: 'scripted grade plus the next question' });
      marks.push({ stage: 'tts-start', t: saidAt + 8, note: 'stub speech' });
      const follow = next.map(l => l.text).join(' ');
      const card = Delivery.deliveryCard([
        { text: answer, start: saidAt - 1800, end: saidAt },
        { text: 'Let me say that in one sentence without the textbook word.', start: saidAt + 2200, end: saidAt + 5000 }
      ], answer + ' Let me say that in one sentence without the textbook word. Um, the idea is the same.');
      return { marks: marks, taught: taught, follow: follow, first: first, card: card, goal: eng.lastGoal || null };
    });
  });
}

function summarize(marks) {
  const stages = ['stt-end', 'llm-complete', 'tts-start'];
  const rows = marks.filter(m => stages.indexOf(m.stage) >= 0);
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].t - rows[i - 1].t);
  const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
  return { count: rows.length, avgGapMs: avg, first: rows[0] || null, last: rows[rows.length - 1] || null };
}

module.exports = { scriptA, runA, runC, summarize };
