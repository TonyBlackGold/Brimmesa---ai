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
  await page2.waitForFunction(() => document.body.dataset.walk === 'arrived' || document.body.dataset.walk === 'trail', { timeout: 8000 });
  await page2.waitForFunction(() => /Morning walks/i.test(document.getElementById('log').textContent), { timeout: 10000 });
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

  console.log('AUDIT UI PASSED');
  await browser.close();
})().catch(err => { console.error('AUDIT UI FAIL', err); process.exit(1); });
