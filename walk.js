// Aria walks a coach onto the map when data/walks.json has a clip plan for them.
// Media stays unloaded until that handoff starts. Other coaches keep the plain zoom.
(function (root) {
  const DATA = 'data/walks.json';
  let doc = null;
  let loading = null;
  let session = 0;
  let skipped = false;
  let onSkip = null;
  let walker = null;
  let sheetImg = null;
  let frameTimer = 0;
  let trail = null;
  let catcher = null;
  let skipBtn = null;
  const skipWaiters = [];

  function reduceMotion() {
    return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
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
  function cleanup() {
    if (frameTimer) cancelAnimationFrame(frameTimer);
    frameTimer = 0;
    if (walker) {
      walker.hidden = true;
      walker.classList.remove('on-map', 'stepping', 'face-right');
    }
    if (trail && trail.parentNode) trail.parentNode.removeChild(trail);
    trail = null;
    if (catcher && catcher.parentNode) catcher.parentNode.removeChild(catcher);
    if (skipBtn && skipBtn.parentNode) skipBtn.parentNode.removeChild(skipBtn);
    catcher = null;
    skipBtn = null;
    if (root.BrimPresenter && root.BrimPresenter.stopOnce) root.BrimPresenter.stopOnce();
  }
  function armSkip(gen) {
    if (catcher) return;
    catcher = document.createElement('button');
    catcher.type = 'button';
    catcher.className = 'walk-catch';
    catcher.setAttribute('aria-label', 'Skip the walk');
    skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'walk-skip';
    skipBtn.textContent = 'Skip';
    const go = function () {
      if (skipped || gen !== session) return;
      skipped = true;
      if (onSkip) onSkip();
      notifySkip();
    };
    catcher.addEventListener('click', go);
    skipBtn.addEventListener('click', go);
    document.body.append(catcher, skipBtn);
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
      document.body.append(walker);
    }
    return walker;
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
  function loopFrames(aria, gen) {
    if (frameTimer) cancelAnimationFrame(frameTimer);
    const fps = aria.fps || 8;
    const t0 = performance.now();
    const step = function (now) {
      if (gen !== session) return;
      const index = reduceMotion() ? 0 : Math.floor((now - t0) / (1000 / fps)) % aria.frames;
      drawFrame(aria, index);
      frameTimer = requestAnimationFrame(step);
    };
    frameTimer = requestAnimationFrame(step);
  }
  function useSheet(aria, gen) {
    if (!aria || !aria.sheet) return;
    if (!sheetImg) {
      sheetImg = new Image();
      sheetImg.decoding = 'async';
      sheetImg.onload = function () { if (gen === session) drawFrame(aria, 0); };
      sheetImg.src = aria.sheet;
    } else if (sheetImg.complete) drawFrame(aria, 0);
    loopFrames(aria, gen);
  }
  function face(dx, aria) {
    if (!walker) return;
    const artLeft = !aria || aria.facing !== 'right';
    const flip = artLeft ? dx > 0.2 : dx < -0.2;
    walker.classList.toggle('face-right', flip);
  }
  function clientPoint(xPct, yPct) {
    const world = document.getElementById('mapWorld');
    if (!world) return null;
    const rect = world.getBoundingClientRect();
    return {
      x: rect.left + (xPct / 100) * rect.width,
      y: rect.top + (yPct / 100) * rect.height
    };
  }
  function parkOnMap(x, y, dx, aria) {
    const world = document.getElementById('mapWorld');
    if (!walker || !world) return;
    walker.classList.remove('corner', 'stepping');
    walker.classList.add('on-map');
    walker.style.left = x + '%';
    walker.style.top = y + '%';
    walker.style.right = 'auto';
    walker.style.bottom = 'auto';
    if (walker.parentNode !== world) world.appendChild(walker);
    face(dx, aria);
  }
  function showTrail(pts) {
    const world = document.getElementById('mapWorld');
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
    const prev = pts[pts.length - 2];
    return { x: last[0], y: last[1], dx: last[0] - prev[0], dy: last[1] - prev[1] };
  }
  function wait(ms, gen) {
    return new Promise(function (resolve) {
      const t = setTimeout(resolve, ms);
      whenSkip().then(function () { clearTimeout(t); resolve(); });
      if (gen !== session) { clearTimeout(t); resolve(); }
    });
  }
  function stepOnto(gen, pt, aria) {
    if (!walker || reduceMotion() || skipped) {
      parkOnMap(pt[0], pt[1], -1, aria);
      return Promise.resolve();
    }
    const from = walker.getBoundingClientRect();
    const spot = clientPoint(pt[0], pt[1]);
    if (!spot || !from.width) {
      parkOnMap(pt[0], pt[1], -1, aria);
      return Promise.resolve();
    }
    walker.classList.add('stepping');
    walker.style.right = 'auto';
    walker.style.bottom = 'auto';
    const x0 = from.left;
    const y0 = from.top;
    const x1 = spot.x - from.width / 2;
    const y1 = spot.y - from.height * 0.92;
    const t0 = performance.now();
    return new Promise(function (resolve) {
      const frame = function (now) {
        if (gen !== session || skipped) { parkOnMap(pt[0], pt[1], -1, aria); resolve(); return; }
        const t = Math.min(1, (now - t0) / 680);
        const e = t * t * (3 - 2 * t);
        walker.style.left = (x0 + (x1 - x0) * e) + 'px';
        walker.style.top = (y0 + (y1 - y0) * e) + 'px';
        if (t < 1) requestAnimationFrame(frame);
        else { parkOnMap(pt[0], pt[1], -1, aria); resolve(); }
      };
      requestAnimationFrame(frame);
    });
  }
  function follow(gen, pts, aria) {
    if (reduceMotion() || skipped) return Promise.resolve();
    const length = pathLength(pts);
    const t0 = performance.now();
    return new Promise(function (resolve) {
      const frame = function (now) {
        if (gen !== session || skipped) { resolve(); return; }
        const t = Math.min(1, (now - t0) / 2800);
        const p = pointAt(pts, length * t);
        parkOnMap(p.x, p.y, p.dx, aria);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  function prepare(coachId) {
    session += 1;
    skipped = false;
    onSkip = null;
    cleanup();
    const gen = session;
    return load().then(function () {
      if (gen !== session) return false;
      return !!planFor(coachId);
    });
  }
  function cueCorner(opts) {
    const aria = doc && doc.aria;
    if (!aria || !aria.sheet) return;
    onSkip = opts && opts.onSkip;
    const gen = session;
    armSkip(gen);
    const el = ensureWalker(aria);
    el.className = 'aria-walker corner';
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.hidden = false;
    document.body.appendChild(el);
    useSheet(aria, gen);
  }
  async function play(opts) {
    opts = opts || {};
    const plan = planFor(opts.coachId);
    const aria = doc && doc.aria;
    if (!plan) return false;
    const world = document.getElementById('mapWorld');
    if (!world) return false;
    const gen = session;
    armSkip(gen);
    try { root.scrollTo(0, 0); } catch (e) {}
    showTrail(plan.waypoints);
    if (walker) await stepOnto(gen, plan.waypoints[0], aria);
    if (gen !== session) return false;
    await follow(gen, plan.waypoints, aria);
    if (gen !== session) return false;
    const dest = opts.dest || {};
    const end = plan.waypoints[plan.waypoints.length - 1];
    const zx = dest.x != null ? dest.x : end[0];
    const zy = dest.y != null ? dest.y : end[1];
    if (root.BrimMap) root.BrimMap.focus(zx, zy);
    await wait(skipped ? 240 : 820, gen);
    if (gen !== session) return false;
    if (walker) walker.hidden = true;
    if (trail && trail.parentNode) trail.parentNode.removeChild(trail);
    trail = null;
    if (!skipped && plan.approach && root.BrimPresenter && root.BrimPresenter.playOnce) {
      await Promise.race([
        root.BrimPresenter.playOnce(plan.approach),
        whenSkip()
      ]);
      if (root.BrimPresenter.stopOnce) root.BrimPresenter.stopOnce();
    }
    if (gen !== session) return false;
    if (plan.talk && root.BrimPresenter) {
      root.BrimPresenter.register(opts.coachId, {
        label: plan.talk.label || opts.coachId,
        mp4: plan.talk.mp4,
        poster: plan.talk.poster || ''
      });
    }
    cleanup();
    return true;
  }
  function cancel() {
    session += 1;
    skipped = true;
    notifySkip();
    cleanup();
  }

  root.BrimWalk = { prepare: prepare, cueCorner: cueCorner, play: play, cancel: cancel };
})(window);
