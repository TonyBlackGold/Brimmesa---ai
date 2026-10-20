// Headless mobile checks for the functionality audit. Run from the repo root:
// node audit-ui.js
const assert = require('assert');
const puppeteer = require('/tmp/pup/node_modules/puppeteer-core');

const URL = process.env.AUDIT_URL || 'http://127.0.0.1:8792/';

function overlaps(a, b) {
  if (!a || !b || a.width < 1 || b.width < 1) return false;
  return !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => {
    const finish = u => { try { if (u && u.onend) u.onend(); } catch (e) {} };
    const synth = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [],
      cancel() {}, pause() {}, resume() {},
      speak: finish,
      addEventListener() {}, removeEventListener() {}
    };
    try { sessionStorage.setItem('brimmesa.entrance.v1', '1'); } catch (e) {}
    try { Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth }); } catch (e) {}
    try { if (window.SpeechSynthesisUtterance) SpeechSynthesisUtterance.prototype.speak = finish; } catch (e) {}
    try {
      if (window.SpeechSynthesis && SpeechSynthesis.prototype) SpeechSynthesis.prototype.speak = finish;
    } catch (e) {}
  });
  page.on('pageerror', err => { console.error('PAGE', err.message); });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    localStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });

  const boot = await page.evaluate(() => ({
    mission: document.getElementById('missionTitle').textContent,
    ready: document.body.dataset.ready,
    level: getComputedStyle(document.getElementById('userLevel')).visibility
  }));
  assert.equal(boot.ready, '1');
  assert.equal(boot.level, 'visible');
  assert.equal(boot.mission, 'Choose a destination');
  assert(!/Wealth/.test(boot.mission));

  await page.evaluate(() => { delete document.body.dataset.ready; });
  const gated = await page.evaluate(() => ({
    level: getComputedStyle(document.getElementById('userLevel')).visibility,
    nav: getComputedStyle(document.querySelector('.bottomnav')).pointerEvents,
    dock: getComputedStyle(document.querySelector('.mic-dock')).pointerEvents
  }));
  assert.equal(gated.level, 'hidden', 'progress stays hidden until ready');
  assert.equal(gated.nav, 'none');
  assert.equal(gated.dock, 'none');
  await page.evaluate(() => { document.body.dataset.ready = '1'; });

  const boxes = await page.evaluate(() => {
    const r = el => {
      const b = el.getBoundingClientRect();
      return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    return {
      type: r(document.getElementById('typeBtn')),
      view: r(document.getElementById('viewBtn')),
      nav: r(document.querySelector('.bottomnav')),
      mic: r(document.getElementById('mic'))
    };
  });
  assert(!overlaps(boxes.type, boxes.nav), 'Type instead overlaps the nav ' + JSON.stringify(boxes));
  assert(!overlaps(boxes.view, boxes.nav), 'View conversation overlaps the nav ' + JSON.stringify(boxes));
  assert(!overlaps(boxes.mic, boxes.nav), 'Mic overlaps the nav');
  assert(boxes.type.height >= 44 && boxes.view.height >= 44 && boxes.mic.height >= 44);
  assert(boxes.type.bottom <= boxes.nav.top + 1);
  assert(boxes.view.bottom <= boxes.nav.top + 1);

  await page.click('.hotspot[data-dest="health"]');
  await page.click('.hotspot[data-dest="travel"]');
  const picked = await page.evaluate(() => ({
    title: document.getElementById('missionTitle').textContent,
    text: document.getElementById('missionText').textContent,
    on: [...document.querySelectorAll('.hotspot.on')].map(n => n.dataset.dest)
  }));
  assert.equal(picked.title, 'Travel & Experiences');
  assert(!/Wealth/.test(picked.title));
  assert.deepEqual(picked.on, ['travel']);
  const startHit = await page.evaluate(() => {
    const go = document.getElementById('missionGo');
    const b = go.getBoundingClientRect();
    const dock = document.querySelector('.mic-dock').getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { id: hit && hit.id, overlap: b.bottom > dock.top + 1 && b.top < dock.bottom - 1, goBottom: b.bottom, dockTop: dock.top };
  });
  assert.equal(startHit.id, 'missionGo', 'Start is covered ' + JSON.stringify(startHit));
  assert.equal(startHit.overlap, false);

  await page.$eval('#missionGo', el => el.scrollIntoView({ block: 'center' }));
  await page.click('#missionGo');
  await page.waitForFunction(() => /cafe abroad/i.test(document.getElementById('log').textContent), { timeout: 8000 });
  const launched = await page.evaluate(() => document.getElementById('log').textContent);
  assert(/cafe abroad/i.test(launched));
  assert(!/small table/i.test(launched));
  assert.equal(await page.$eval('#missionTitle', n => n.textContent), 'Travel & Experiences');

  await page.click('#tabCoaches');
  await page.waitForSelector('#coachGrid button');
  const coaches = await page.$$eval('#coachGrid button', nodes => nodes.map(n => n.innerText));
  assert(coaches.some(t => /Marcus/.test(t)) && coaches.some(t => /Amara/.test(t)) && coaches.some(t => /Jasmine/.test(t)) && coaches.some(t => /Renee/.test(t)));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#coachGrid button')].find(n => /Amara/.test(n.innerText));
    b.scrollIntoView({ block: 'center' });
    b.click();
  });
  await page.waitForFunction(() => /Morning walks/i.test(document.getElementById('log').textContent), { timeout: 8000 });
  const amaraVisit = await page.evaluate(() => ({
    name: document.getElementById('visitName').textContent,
    src: document.getElementById('visitImg').src,
    line: document.getElementById('visitLine').textContent
  }));
  assert.equal(amaraVisit.name, 'Coach Amara');
  assert(/amara\.webp/.test(amaraVisit.src));
  assert(/Morning walks/i.test(amaraVisit.line));
  assert(/kids wake up/i.test(amaraVisit.line));
  assert(/creator|meeting/i.test(amaraVisit.line));

  await page.click('#tabCoaches');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#coachGrid button')].find(n => /Marcus/.test(n.innerText));
    b.scrollIntoView({ block: 'center' });
    b.click();
  });
  await page.waitForFunction(() => /Marcus/.test(document.getElementById('visitName').textContent), { timeout: 8000 });
  const marcusVisit = await page.evaluate(() => ({
    name: document.getElementById('visitName').textContent,
    src: document.getElementById('visitImg').src,
    speaker: (document.querySelector('#log .l:last-child') || {}).className || ''
  }));
  assert.equal(marcusVisit.name, 'Marcus');
  assert(/marcus\.webp/.test(marcusVisit.src));

  await page.click('#typeBtn');
  await page.waitForSelector('#typeRow:not([hidden])');
  await page.type('#txt', 'what is MFA');
  await page.$eval('#typeRow', form => form.requestSubmit());
  await page.waitForFunction(() => /Multifactor authentication/i.test(document.getElementById('log').textContent), { timeout: 8000 });
  const marcusLog = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#log .l')].slice(-3).map(n => n.innerText);
    return rows.join('\n');
  });
  assert(/Multifactor authentication/i.test(marcusLog));
  assert(!/Ransomware/.test(marcusLog));
  assert(!/Say challenge, quiz, or teach/.test(marcusLog));
  const speakerNow = await page.evaluate(() => ({
    name: document.getElementById('visitName').textContent,
    src: document.getElementById('visitImg').src
  }));
  assert.equal(speakerNow.name, 'Marcus');
  assert(/marcus\.webp/.test(speakerNow.src));

  const after = await page.evaluate(() => {
    const r = el => {
      const b = el.getBoundingClientRect();
      return { top: b.top, left: b.left, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    const pres = document.querySelector('.presenter');
    return {
      type: r(document.getElementById('typeBtn')),
      view: r(document.getElementById('viewBtn')),
      nav: r(document.querySelector('.bottomnav')),
      presenter: pres ? r(pres) : null
    };
  });
  assert(!overlaps(after.type, after.nav));
  assert(!overlaps(after.view, after.nav));
  if (after.presenter && after.presenter.height > 20) {
    assert(!overlaps(after.view, after.presenter), 'View conversation is under Amara ' + JSON.stringify(after));
    assert(!overlaps(after.type, after.presenter));
  }

  await page.click('#tabMap');
  await page.waitForSelector('.hotspot[data-dest="affairs"]');
  await page.click('.hotspot[data-dest="affairs"]');
  const affairs = await page.evaluate(() => ({
    title: document.getElementById('missionTitle').textContent,
    on: [...document.querySelectorAll('.hotspot.on')].map(n => n.dataset.dest)
  }));
  assert.equal(affairs.title, 'Current Affairs');
  assert.deepEqual(affairs.on, ['affairs']);
  await page.$eval('#missionGo', el => el.scrollIntoView({ block: 'center' }));
  await page.click('#missionGo');
  await page.waitForFunction(() => /skill drill|Reporting/i.test(document.getElementById('log').textContent), { timeout: 12000 });
  const affairLog = await page.$eval('#log', n => n.textContent);
  if (/will not invent/i.test(affairLog)) assert(/skill drill/i.test(affairLog));
  else assert(/Reporting/i.test(affairLog) && /wikipedia/i.test(affairLog) && /https?:\/\//i.test(affairLog));
  const ctxCheck = await page.evaluate(async () => {
    const before = BrimContext.snapshot();
    const denied = BrimContext.answer('what is the weather', before);
    return { clock: before.clock.tag, holidays: before.holidays.tag, weather: before.weather.tag, denied: denied };
  });
  assert.equal(ctxCheck.clock, 'LIVE');
  assert.equal(ctxCheck.holidays, 'LIVE');
  if (ctxCheck.weather !== 'LIVE') assert(/don't have the weather|won't guess/i.test(ctxCheck.denied));

  const page2 = await browser.newPage();
  await page2.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await page2.evaluateOnNewDocument(() => {
    const finish = u => { try { if (u && u.onend) u.onend(); } catch (e) {} };
    const synth = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [], cancel() {}, pause() {}, resume() {}, speak: finish,
      addEventListener() {}, removeEventListener() {}
    };
    try { Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth }); } catch (e) {}
  });
  await page2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page2.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    localStorage.clear();
    sessionStorage.removeItem('brimmesa.entrance.v1');
  });
  await page2.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page2.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
  await page2.waitForFunction(() => document.body.dataset.entrance === 'plaza' && document.getElementById('ariaWalker') && !document.getElementById('ariaWalker').hidden, { timeout: 8000 });
  await page2.click('.walk-skip');
  await page2.waitForFunction(() => document.body.dataset.entrance === 'skipped', { timeout: 4000 });
  await page2.click('.hotspot[data-dest="health"]');
  assert.equal(await page2.$eval('#missionTitle', n => n.textContent), 'Health & Fitness');
  await page2.click('#tabCoaches');
  await page2.waitForSelector('#coachGrid button');
  await page2.evaluate(() => {
    const b = [...document.querySelectorAll('#coachGrid button')].find(n => /Amara/.test(n.innerText));
    b.scrollIntoView({ block: 'center' });
    b.click();
  });
  await page2.waitForSelector('.walk-skip', { timeout: 8000 });
  await page2.click('.walk-skip');
  await page2.waitForFunction(() => /This is Amara, at Mindset/i.test(document.getElementById('log').textContent) && /Morning walks/i.test(document.getElementById('log').textContent), { timeout: 10000 });
  const figures = await page2.evaluate(() => ({
    amara: !!document.querySelector('.cast-figure[data-coach="amara"]'),
    jasmine: !!document.querySelector('.cast-figure[data-coach="jasmine"]'),
    depth: BrimWorld.depthAt(20) < BrimWorld.depthAt(70)
  }));
  assert(figures.amara && figures.jasmine && figures.depth);

  await page2.evaluate(() => {
    localStorage.setItem('brimmesa.learner.marcus', JSON.stringify({ met: true, domains: { cia: 80 } }));
    const board = BrimGym.loadBoard();
    const marcus = BrimGym.coachOf(board, 'marcus');
    marcus.step = 'evaluate';
    marcus.mode = 'challenge';
    let next = BrimGym.putCoach(board, 'marcus', marcus);
    const amara = BrimGym.coachOf(next, 'amara');
    amara.mode = 'coaching';
    amara.step = 'response';
    next = BrimGym.putCoach(next, 'amara', amara);
    BrimGym.saveBoard(next);
    const sel = document.getElementById('coachMode');
    if (sel) sel.value = 'coaching';
  });
  await page2.evaluate(() => document.getElementById('typeBtn').click());
  await page2.waitForSelector('#typeRow:not([hidden])');
  await page2.type('#txt', 'ok');
  await page2.$eval('#typeRow', form => form.requestSubmit());
  await page2.waitForFunction(() => /push back/i.test(document.getElementById('log').textContent), { timeout: 8000 });
  const isolated = await page2.evaluate(() => {
    const board = BrimGym.loadBoard();
    const profile = BrimGym.loadProfile();
    return {
      amara: board.amara && board.amara.step,
      marcus: board.marcus && board.marcus.step,
      marcusMode: board.marcus && board.marcus.mode,
      cia: JSON.parse(localStorage.getItem('brimmesa.learner.marcus')).domains.cia,
      summary: profile.summary || '',
      live: (profile.lessons || []).some(l => l.id === 'amara-live' && l.step === 'adapt')
    };
  });
  assert.equal(isolated.amara, 'adapt');
  assert.equal(isolated.marcus, 'evaluate');
  assert.equal(isolated.marcusMode, 'challenge');
  assert.equal(isolated.cia, 80);
  assert(isolated.live);
  assert(/ok/.test(isolated.summary));
  const switched = await page2.evaluate(() => {
    const sel = document.getElementById('coachMode');
    sel.value = 'freetalk';
    sel.dispatchEvent(new Event('change'));
    const board = BrimGym.loadBoard();
    return { amara: board.amara.mode, marcus: board.marcus.mode };
  });
  assert.equal(switched.amara, 'freetalk');
  assert.equal(switched.marcus, 'challenge');
  await page2.click('#tabProgress');
  await page2.type('#profileObjective', 'Speak up at work');
  await page2.$eval('#profileForm', form => form.requestSubmit());
  await page2.waitForFunction(() => /Speak up at work/.test(document.getElementById('profileReview').textContent));
  await page2.$eval('#profileDelete', el => el.scrollIntoView({ block: 'center' }));
  const deleteHit = await page2.evaluate(() => {
    const el = document.getElementById('profileDelete');
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + Math.min(12, b.width / 2), b.top + b.height / 2);
    return { id: top && top.id, cls: top && top.className, y: Math.round(b.top), h: Math.round(b.height) };
  });
  assert.equal(deleteHit.id, 'profileDelete', 'Delete is covered ' + JSON.stringify(deleteHit));
  await page2.$eval('#profileDelete', el => el.click());
  assert.equal(await page2.$eval('#profileDelete', n => n.textContent), 'Confirm delete');
  await page2.$eval('#profileDelete', el => el.click());
  const afterDelete = await page2.evaluate(() => ({
    profile: localStorage.getItem('brimmesa.learner.profile.v1'),
    marcus: JSON.parse(localStorage.getItem('brimmesa.learner.marcus')).domains.cia,
    review: document.getElementById('profileReview').textContent
  }));
  assert.equal(afterDelete.profile, null);
  assert.equal(afterDelete.marcus, 80);
  assert(!/Speak up at work/.test(afterDelete.review));

  const page3 = await browser.newPage();
  await page3.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page3.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
  await page3.evaluateOnNewDocument(() => {
    const finish = u => { try { if (u && u.onend) u.onend(); } catch (e) {} };
    const synth = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [], cancel() {}, pause() {}, resume() {}, speak: finish,
      addEventListener() {}, removeEventListener() {}
    };
    try { sessionStorage.setItem('brimmesa.entrance.v1', '1'); } catch (e) {}
    try { Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth }); } catch (e) {}
    window.__srStarts = 0;
    window.__srQueue = [];
    window.__gum = 0;
    function FakeRec() {}
    FakeRec.prototype.start = function () {
      window.__srStarts += 1;
      const job = window.__srQueue.shift();
      if (!job) return;
      const self = this;
      this._timer = setTimeout(() => {
        this._timer = 0;
        if (self.onresult) {
          self.onresult({
            resultIndex: 0,
            results: [{ 0: { transcript: job.text }, isFinal: true, length: 1 }]
          });
        }
        if (self.onend) self.onend();
      }, job.delay || 30);
    };
    FakeRec.prototype.abort = function () {
      if (this._timer) clearTimeout(this._timer);
      this._timer = 0;
      if (this.onend) this.onend();
    };
    FakeRec.prototype.stop = function () { this.abort(); };
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
    const blockMic = () => {
      window.__gum += 1;
      return Promise.reject(new Error('energy stream blocked in this check'));
    };
    try {
      if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
      navigator.mediaDevices.getUserMedia = blockMic;
    } catch (e) {}
  });
  page3.on('pageerror', err => { console.error('PAGE3', err.message); });
  await page3.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page3.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    localStorage.clear();
    localStorage.setItem('brimmesa.profile.v1', JSON.stringify({
      name: 'Tony', xp: 0, streak: 0, lastDay: null, mastery: {}, history: [], lastActivity: null, lastFeedback: null, driving: false
    }));
    sessionStorage.setItem('brimmesa.entrance.v1', '1');
  });
  await page3.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await page3.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
  const phoneBoot = await page3.evaluate(() => ({
    handsFree: document.getElementById('auto').checked,
    energy: BrimVad.allowEnergyStream(navigator.userAgent, true),
    status: document.getElementById('voiceStatus').textContent,
    vocab: !!document.getElementById('vocabGo'),
    speech: !!document.getElementById('speechGo')
  }));
  assert.equal(phoneBoot.handsFree, false, 'press-to-talk is the phone default');
  assert.equal(phoneBoot.energy, false);
  assert(/Ready/.test(phoneBoot.status));
  assert(phoneBoot.vocab && phoneBoot.speech);
  await page3.evaluate(() => { window.__srQueue.push({ text: 'vocabulary', delay: 40 }); });
  await page3.click('#mic');
  await page3.waitForFunction(() => /Word of the day/i.test(document.getElementById('log').textContent) && /brief/i.test(document.getElementById('log').textContent), { timeout: 12000 });
  const afterVoice = await page3.evaluate(() => ({
    gum: window.__gum,
    starts: window.__srStarts,
    log: document.getElementById('log').textContent,
    status: document.getElementById('voiceStatus').textContent
  }));
  assert.equal(afterVoice.gum, 0, 'Android must not open a second microphone');
  assert(afterVoice.starts >= 1 && afterVoice.starts <= 2, 'recognition starts ' + afterVoice.starts);
  assert(/Tony, I'm Aria|I'm Aria/.test(afterVoice.log));
  assert(/Word of the day/.test(afterVoice.log));
  assert(/Listening|Heard|Speaking|Ready|Error/.test(afterVoice.status));
  await page3.evaluate(() => document.getElementById('typeBtn').click());
  await page3.waitForSelector('#typeRow:not([hidden])');
  await page3.type('#txt', 'I will be brief when I speak today');
  await page3.$eval('#typeRow', form => form.requestSubmit());
  await page3.waitForFunction(() => /You used brief/i.test(document.getElementById('log').textContent), { timeout: 8000 });
  const storedVocab = await page3.evaluate(() => {
    const raw = localStorage.getItem('brimmesa.learner.profile.v1');
    const profile = raw ? JSON.parse(raw) : null;
    const box = profile && profile.vocab && profile.vocab.box && profile.vocab.box.brief;
    return { n: box && box.n, due: box && box.due };
  });
  assert(storedVocab.n >= 1 && storedVocab.due > Date.now() - 1000);
  await page3.click('#speechGo');
  await page3.waitForFunction(() => /sixty seconds/i.test(document.getElementById('log').textContent), { timeout: 8000 });
  const talk = 'Um I will explain one change and why it matters to the team today uh then I will stop and take one question from the room';
  await page3.evaluate(text => { window.__srQueue.push({ text: text, delay: 1100 }); }, talk);
  await page3.click('#mic');
  await page3.waitForFunction(() => /Scorecard/.test(document.getElementById('log').textContent) && /Filler words/.test(document.getElementById('log').textContent), { timeout: 12000 });
  const scored = await page3.evaluate(() => ({
    gum: window.__gum,
    starts: window.__srStarts,
    log: document.getElementById('log').textContent,
    card: document.getElementById('scorecardBody').textContent,
    hidden: document.getElementById('scorecard').hidden,
    status: document.getElementById('voiceStatus').textContent
  }));
  assert.equal(scored.gum, 0);
  assert(scored.starts <= 4, 'recognition did not spin, starts ' + scored.starts);
  assert(/Filler words: [1-9]/.test(scored.log));
  assert(/Tip:/.test(scored.log));
  assert(!/confidence|emotion/i.test(scored.log));
  assert.equal(scored.hidden, false);
  assert(/Filler words/.test(scored.card));
  assert(scored.status && scored.status.length > 3);
  await page3.type('#txt', 'Tell me something useful about practicing out loud');
  await page3.$eval('#typeRow', form => form.requestSubmit());
  await page3.waitForFunction(() => /didn't catch which one/i.test(document.getElementById('log').textContent), { timeout: 8000 });

  const page4 = await browser.newPage();
  await page4.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page4.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
  await page4.evaluateOnNewDocument(() => {
    const synth = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [], cancel() {}, pause() {}, resume() {},
      speak() {},
      addEventListener() {}, removeEventListener() {}
    };
    try { sessionStorage.setItem('brimmesa.entrance.v1', '1'); } catch (e) {}
    try { Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth }); } catch (e) {}
    const origFetch = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      const u = String(url && url.url || url || '');
      if (/generativelanguage\.googleapis\.com|api\.elevenlabs\.io/i.test(u)) {
        return new Promise((resolve, reject) => {
          const signal = opts && opts.signal;
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal) {
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail);
          }
        });
      }
      return origFetch(url, opts);
    };
  });
  await page4.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page4.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    localStorage.clear();
    localStorage.setItem('brimmesa.profile.v1', JSON.stringify({
      name: 'Tony', xp: 0, streak: 0, lastDay: null, mastery: {}, history: [], lastActivity: null, lastFeedback: null, driving: false
    }));
    localStorage.setItem('brimmesa.gemini.key', 'not-a-real-key');
    sessionStorage.setItem('brimmesa.entrance.v1', '1');
  });
  await page4.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page4.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
  await page4.evaluate(() => document.getElementById('typeBtn').click());
  await page4.waitForSelector('#typeRow:not([hidden])');
  const hangStarted = Date.now();
  await page4.type('#txt', 'Tell me something useful about practicing out loud');
  await page4.$eval('#typeRow', form => form.requestSubmit());
  await page4.waitForFunction(() => /Thinking/.test(document.getElementById('voiceStatus').textContent), { timeout: 1000 });
  await page4.waitForFunction(() => /didn't catch which one/i.test(document.getElementById('log').textContent), { timeout: 12000 });
  const textAt = Date.now() - hangStarted;
  assert(textAt < 10000, 'first text took ' + textAt);
  await page4.waitForFunction(() => {
    const marks = (window.BrimLatency && window.BrimLatency.marks) || [];
    const chip = document.getElementById('voiceStatus').textContent || '';
    const llm = marks.some(m => m.stage === 'llm-timeout');
    const voice = marks.some(m => m.stage === 'tts-timeout' || m.stage === 'tts-browser-timeout') || /backup voice/i.test(chip);
    return llm && voice;
  }, { timeout: 20000 });
  const hung = await page4.evaluate(() => {
    const marks = (window.BrimLatency && window.BrimLatency.marks) || [];
    return {
      stages: marks.map(m => m.stage + (m.note ? ' ' + m.note : '')),
      chip: document.getElementById('voiceStatus').textContent
    };
  });
  assert(hung.stages.some(s => s.indexOf('llm-timeout') === 0), JSON.stringify(hung.stages));
  assert(Date.now() - hangStarted < 22000, 'hang path took ' + (Date.now() - hangStarted));

  console.log('AUDIT UI PASSED');
  await browser.close();
})().catch(err => { console.error('AUDIT UI FAIL', err); process.exit(1); });
