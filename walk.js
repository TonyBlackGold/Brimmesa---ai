// Aria on the painted map: one sprite, one animation frame loop, camera follow.
// Coach figures reuse art that already shipped. Nothing here is a new render.
(function (root) {
  const DATA = 'data/walks.json';
  const ENTRANCE_KEY = 'brimmesa.entrance.v1';

  function depthAt(y) {
    const t = Math.max(0, Math.min(100, Number(y) || 0)) / 100;
    return 0.62 + t * 0.7;
  }
  function spritePx(y, zoom, base) {
    const z = Math.max(1, Number(zoom) || 1);
    return ((base || 78) * depthAt(y)) / z;
  }
  function cameraTarget(x, y, zoom, w, h) {
    const scale = Math.max(1, Math.min(3.2, Number(zoom) || 1));
    const width = w || 1;
    const height = h || 1;
    let tx = width / 2 - (Number(x) / 100) * width * scale;
    let ty = height / 2 - (Number(y) / 100) * height * scale;
    const minX = Math.min(0, width - width * scale);
    const minY = Math.min(0, height - height * scale);
    tx = Math.max(minX, Math.min(0, tx));
    ty = Math.max(minY, Math.min(0, ty));
    return { scale: scale, tx: tx, ty: ty };
  }
  function jawAmount(name) {
    const key = String(name || '').replace(/^viseme_/i, '');
    if (!key || key === 'rest') return 0;
    if (key === 'PP' || key === 'FF') return 0.08;
    if (key === 'aa' || key === 'O') return 1;
    if (key === 'E' || key === 'I' || key === 'U') return 0.55;
    return 0.35;
  }
  function pathLength(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return total || 1;
  }
  function pointAt(pts, dist) {
    let left = dist;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      const seg = Math.hypot(dx, dy) || 0.0001;
      if (left <= seg) {
        const t = left / seg;
        return { x: pts[i - 1][0] + dx * t, y: pts[i - 1][1] + dy * t, dx: dx, dy: dy };
      }
      left -= seg;
    }
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2] || last;
    return { x: last[0], y: last[1], dx: last[0] - prev[0], dy: last[1] - prev[1] };
  }

  const geom = { depthAt: depthAt, spritePx: spritePx, cameraTarget: cameraTarget, jawAmount: jawAmount, pathLength: pathLength, pointAt: pointAt };

  let doc = null;
  let loading = null;
  let session = 0;
  let skipped = false;
  let onSkip = null;
  let walker = null;
  let sheetImg = null;
  let frameTimer = 0;
  let trail = null;
  let skipBtn = null;
  let figures = {};
  let sheetCache = {};
  let loopOn = false;
  let mode = 'idle';
  let entranceTimer = 0;
  let walkJob = null;
  const skipWaiters = [];

  function reduceMotion() {
    return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function worldEl() { return document.getElementById('mapWorld'); }
  function setPhase(name) {
    if (document.body) document.body.dataset.entrance = name;
  }
  function load() {
    if (doc) return Promise.resolve(doc);
    if (!loading) {
      loading = fetch(DATA).then(function (res) { return res.ok ? res.json() : null; }).then(function (json) {
        doc = json || { coaches: {} };
        return doc;
      }).catch(function () {
        doc = { coaches: {} };
        return doc;
      });
    }
    return loading;
  }
  function planFor(id) {
    const coaches = doc && doc.coaches;
    const plan = coaches && coaches[id];
    if (!plan || !plan.waypoints || plan.waypoints.length < 2) return null;
    return plan;
  }
  function notifySkip() {
    const waiters = skipWaiters.splice(0);
    waiters.forEach(function (fn) { fn(); });
  }
  function whenSkip() {
    if (skipped) return Promise.resolve();
    return new Promise(function (resolve) { skipWaiters.push(resolve); });
  }
  function wait(ms, gen) {
    return new Promise(function (resolve) {
      const t = setTimeout(resolve, ms);
      whenSkip().then(function () { clearTimeout(t); resolve(); });
      if (gen !== session) { clearTimeout(t); resolve(); }
    });
  }
  function dropSkip() {
    if (skipBtn && skipBtn.parentNode) skipBtn.parentNode.removeChild(skipBtn);
    skipBtn = null;
    onSkip = null;
  }
  function armSkip(gen, label) {
    dropSkip();
    skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'walk-skip';
    skipBtn.textContent = label || 'Skip';
    skipBtn.addEventListener('click', function () {
      if (skipped || gen !== session) return;
      skipped = true;
      if (onSkip) onSkip();
      notifySkip();
    });
    document.body.appendChild(skipBtn);
  }
  function stopLoop() {
    loopOn = false;
    if (frameTimer) cancelAnimationFrame(frameTimer);
    frameTimer = 0;
    if (walkJob) {
      const job = walkJob;
      walkJob = null;
      job.resolve();
    }
  }
  function visualZoom() {
    const pose = root.BrimMap && root.BrimMap.pose && root.BrimMap.pose();
    const world = worldEl();
    if (!world) return (pose && pose.scale) || 1;
    const tr = getComputedStyle(world).transform;
    const mm = tr && tr.match(/matrix\(([^)]+)\)/);
    if (mm) {
      const a = parseFloat(mm[1].split(',')[0]);
      if (a) return a;
    }
    return (pose && pose.scale) || 1;
  }
  function startLoop() {
    if (loopOn || reduceMotion()) return;
    loopOn = true;
    const step = function (now) {
      if (!loopOn) return;
      const aria = doc && doc.aria;
      if (walkJob) {
        const job = walkJob;
        if (job.gen !== session || skipped) {
          walkJob = null;
          job.resolve();
        } else {
          const t = Math.min(1, (now - job.t0) / job.dur);
          const p = pointAt(job.pts, job.length * t);
          park(p.x, p.y, p.dx, job.aria);
          if (root.BrimMap && root.BrimMap.follow) root.BrimMap.follow(p.x, p.y, 1.85);
          if (aria && sheetImg) {
            const index = Math.floor(now / (1000 / (aria.fps || 8))) % (aria.frames || 1);
            drawFrame(aria, index);
          }
          if (t >= 1) {
            walkJob = null;
            job.resolve();
          }
        }
      } else if (walker && aria) drawFrame(aria, aria.idleFrame || 0);
      bobFigures(now);
      resizeAll();
      frameTimer = requestAnimationFrame(step);
    };
    frameTimer = requestAnimationFrame(step);
  }
  function bobFigures(now) {
    const bob = Math.sin(now / 520) * 2.4;
    Object.keys(figures).forEach(function (id) {
      const el = figures[id];
      if (!el || el.hidden) return;
      el.style.transform = 'translate(-50%, -92%) translateY(' + bob + 'px)';
    });
    if (walker && walker.classList.contains('on-map')) {
      walker.style.transform = 'translate(-50%, -92%) translateY(' + bob + 'px)';
    }
  }
  function resizeEl(el, y, fw, fh) {
    const pose = root.BrimMap && root.BrimMap.pose && root.BrimMap.pose();
    if (!pose || !pose.w) return;
    const height = spritePx(y, visualZoom(), 78);
    const width = height * ((fw || 112) / (fh || 198));
    el.style.width = ((width / pose.w) * 100) + '%';
  }
  function drawFrame(aria, index) {
    if (!walker || !sheetImg || !sheetImg.complete || !sheetImg.naturalWidth) return;
    const canvas = walker.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const fw = aria.frameWidth;
    const fh = aria.frameHeight;
    const col = index % aria.cols;
    const row = Math.floor(index / aria.cols);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sheetImg, col * fw, row * fh, fw, fh, 0, 0, canvas.width, canvas.height);
  }
  function ensureWalker(aria) {
    if (!walker) {
      walker = document.createElement('div');
      walker.id = 'ariaWalker';
      walker.className = 'aria-walker';
      walker.hidden = true;
      walker.setAttribute('aria-hidden', 'true');
      const canvas = document.createElement('canvas');
      canvas.width = aria.frameWidth || 112;
      canvas.height = aria.frameHeight || 198;
      walker.append(canvas);
    }
    return walker;
  }
  function useSheet(aria, gen) {
    if (!aria || !aria.sheet) return;
    if (!sheetImg) {
      sheetImg = new Image();
      sheetImg.decoding = 'async';
      sheetImg.onload = function () { if (gen === session) drawFrame(aria, aria.idleFrame || 0); };
      sheetImg.src = aria.sheet;
    } else if (sheetImg.complete) drawFrame(aria, aria.idleFrame || 0);
  }
  function face(dx, aria) {
    if (!walker) return;
    const artLeft = !aria || aria.facing !== 'right';
    const flip = artLeft ? dx > 0.2 : dx < -0.2;
    const canvas = walker.querySelector('canvas');
    if (canvas) canvas.style.transform = flip ? 'scaleX(-1)' : '';
  }
  function park(x, y, dx, aria) {
    const world = worldEl();
    if (!walker || !world) return;
    walker.classList.remove('corner', 'stepping');
    walker.classList.add('on-map');
    walker.hidden = false;
    walker.style.left = x + '%';
    walker.style.top = y + '%';
    walker.style.right = 'auto';
    walker.style.bottom = 'auto';
    if (walker.parentNode !== world) world.appendChild(walker);
    resizeEl(walker, y, aria && aria.frameWidth, aria && aria.frameHeight);
    face(dx, aria);
  }
  function showTrail(pts) {
    const world = worldEl();
    if (!world) return;
    if (trail && trail.parentNode) trail.parentNode.removeChild(trail);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'walk-trail');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    const points = pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
    ['glow', 'core'].forEach(function (name) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('class', name);
      line.setAttribute('points', points);
      svg.appendChild(line);
    });
    world.appendChild(svg);
    trail = svg;
  }
  function hideTrail() {
    if (trail && trail.parentNode) trail.parentNode.removeChild(trail);
    trail = null;
  }
  function loadSheet(spec) {
    if (!spec || !spec.src) return Promise.resolve(null);
    if (sheetCache[spec.src]) return Promise.resolve(sheetCache[spec.src]);
    return new Promise(function (resolve) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = function () { sheetCache[spec.src] = img; resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = spec.src;
    });
  }
  function paintSheetFigure(el, spec, img) {
    if (!img) return;
    const canvas = el.querySelector('canvas') || document.createElement('canvas');
    canvas.width = spec.fw;
    canvas.height = spec.fh;
    const ctx = canvas.getContext('2d');
    const index = spec.frame || 0;
    const col = index % spec.cols;
    const row = Math.floor(index / spec.cols);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, col * spec.fw, row * spec.fh, spec.fw, spec.fh, 0, 0, canvas.width, canvas.height);
    if (!canvas.parentNode) el.appendChild(canvas);
  }
  function ensureFigure(id, plan) {
    const spec = plan && plan.figure;
    const stand = plan && (plan.stand || plan.waypoints[plan.waypoints.length - 1]);
    if (!spec || !stand) return null;
    let el = figures[id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'cast-figure' + (spec.kind === 'portrait' ? ' is-portrait' : ' is-sheet');
      el.dataset.coach = id;
      el.setAttribute('aria-hidden', 'true');
      el.style.left = stand[0] + '%';
      el.style.top = stand[1] + '%';
      figures[id] = el;
      const world = worldEl();
      if (world) world.appendChild(el);
      if (spec.kind === 'portrait') {
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.src = spec.src;
        el.appendChild(img);
      } else {
        loadSheet(spec).then(function (img) { if (figures[id] === el) paintSheetFigure(el, spec, img); });
      }
    }
    const fw = spec.kind === 'sheet' ? spec.fw : 112;
    const fh = spec.kind === 'sheet' ? spec.fh : 150;
    resizeEl(el, stand[1], fw, fh);
    el.hidden = false;
    return el;
  }
  function showCast() {
    const coaches = doc && doc.coaches || {};
    Object.keys(coaches).forEach(function (id) { ensureFigure(id, coaches[id]); });
  }
  function resizeAll() {
    const aria = doc && doc.aria;
    if (walker && walker.classList.contains('on-map') && aria) {
      resizeEl(walker, parseFloat(walker.style.top), aria.frameWidth, aria.frameHeight);
    }
    const coaches = doc && doc.coaches || {};
    Object.keys(figures).forEach(function (id) {
      const plan = coaches[id];
      const spec = plan && plan.figure;
      const stand = plan && (plan.stand || [0, 50]);
      if (!spec) return;
      resizeEl(figures[id], stand[1], spec.kind === 'sheet' ? spec.fw : 112, spec.kind === 'sheet' ? spec.fh : 150);
    });
  }
  function follow(gen, pts, aria) {
    return new Promise(function (resolve) {
      walkJob = { gen: gen, pts: pts, aria: aria, t0: performance.now(), dur: 2200, length: pathLength(pts), resolve: resolve };
      startLoop();
    });
  }
  function clearFollow() {
    const stage = document.getElementById('mapStage');
    if (stage) delete stage.dataset.follow;
  }

  function prepare(coachId) {
    session += 1;
    skipped = false;
    onSkip = null;
    dropSkip();
    hideTrail();
    clearFollow();
    const gen = session;
    return load().then(function () {
      if (gen !== session) return false;
      return !!planFor(coachId);
    });
  }
  function cueCorner() { return; }
  function wasSkipped() { return skipped; }

  async function play(opts) {
    opts = opts || {};
    const plan = planFor(opts.coachId);
    const aria = doc && doc.aria;
    if (!plan || !aria) return false;
    const world = worldEl();
    if (!world) return false;
    const gen = session;
    mode = 'walk';
    stopLoop();
    if (document.body) document.body.dataset.walk = 'out';
    const stage = document.getElementById('mapStage');
    if (stage) stage.dataset.follow = '1';
    armSkip(gen, 'Skip');
    showCast();
    ensureWalker(aria);
    useSheet(aria, gen);
    startLoop();
    const pts = plan.waypoints;
    park(pts[0][0], pts[0][1], -1, aria);
    showTrail(pts);
    try { root.scrollTo(0, 0); } catch (e) {}
    if (root.BrimMap && root.BrimMap.look && !reduceMotion()) {
      root.BrimMap.look(pts[0][0], pts[0][1], 1.2, { ms: 560 });
      await wait(560, gen);
    }
    if (gen !== session) return false;
    if (document.body) document.body.dataset.walk = 'trail';
    if (!reduceMotion() && !skipped) await follow(gen, pts, aria);
    if (gen !== session) return false;
    const end = pts[pts.length - 1];
    const dest = opts.dest || {};
    const zx = dest.x != null ? dest.x : end[0];
    const zy = dest.y != null ? dest.y : end[1];
    park(end[0], end[1], -1, aria);
    if (root.BrimMap && root.BrimMap.look) root.BrimMap.look(zx, zy, skipped || reduceMotion() ? 2.05 : 2.15, { ms: skipped ? 0 : 420 });
    if (!skipped && !reduceMotion()) await wait(460, gen);
    if (document.body) document.body.dataset.walk = 'arrived';
    mode = 'idle';
    clearFollow();
    dropSkip();
    hideTrail();
    resizeAll();
    return true;
  }
  function cancel() {
    session += 1;
    skipped = true;
    mode = 'idle';
    notifySkip();
    dropSkip();
    hideTrail();
    clearFollow();
    if (entranceTimer) clearTimeout(entranceTimer);
    entranceTimer = 0;
  }
  function placeHome(gen) {
    const aria = doc && doc.aria;
    if (!aria) return;
    const home = aria.home || [58, 55];
    ensureWalker(aria);
    useSheet(aria, gen);
    park(home[0], home[1], -1, aria);
    drawFrame(aria, aria.idleFrame || 0);
    showCast();
    resizeAll();
    startLoop();
  }
  function finishEntrance(gen, how) {
    if (gen !== session) return;
    try { sessionStorage.setItem(ENTRANCE_KEY, '1'); } catch (e) {}
    dropSkip();
    setPhase(how || 'done');
    if (how === 'skipped' && root.BrimMap && root.BrimMap.fit) root.BrimMap.fit({ instant: true });
    resizeAll();
    if (how !== 'skipped' && typeof root.BrimMeet === 'function') root.BrimMeet();
  }
  function entrance() {
    if (reduceMotion()) {
      try { sessionStorage.setItem(ENTRANCE_KEY, '1'); } catch (e) {}
      setPhase('reduced');
      return;
    }
    try { if (sessionStorage.getItem(ENTRANCE_KEY) === '1') { setPhase('done'); return; } } catch (e) {}
    session += 1;
    skipped = false;
    const gen = session;
    mode = 'idle';
    setPhase('overview');
    load().then(function () {
      if (gen !== session) return;
      if (root.BrimMap && root.BrimMap.fit) root.BrimMap.fit({ instant: true });
      placeHome(gen);
      armSkip(gen, 'Skip');
      onSkip = function () { finishEntrance(gen, 'skipped'); };
      entranceTimer = setTimeout(function () {
        if (gen !== session || skipped) return;
        setPhase('plaza');
        if (root.BrimMap && root.BrimMap.look) root.BrimMap.look(58, 52, 2.05, { ms: 1400 });
        entranceTimer = setTimeout(function () {
          if (gen !== session || skipped) return;
          finishEntrance(gen, 'face');
        }, 2800);
      }, 280);
    });
  }

  root.BrimWorld = geom;
  root.BrimWalk = {
    prepare: prepare,
    cueCorner: cueCorner,
    play: play,
    cancel: cancel,
    wasSkipped: wasSkipped,
    entrance: entrance,
    resize: resizeAll
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = geom;
})(typeof window !== 'undefined' ? window : globalThis);
