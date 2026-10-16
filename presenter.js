// Miniature full-body presenter. Amara is a transparent sprite sheet (iOS Safari
// does not play WebM alpha). Another coach can still register an mp4.
// Media is not requested until that coach is actually shown.
(function (root) {
  const PRESENTERS = {
    amara: {
      label: 'Amara',
      sheet: 'assets/amara-full-sheet.webp',
      frames: 48,
      cols: 8,
      frameWidth: 180,
      frameHeight: 318,
      fps: 8,
      idleFrame: 24
    }
  };
  const HIDE_KEY = 'brimmesa.presenter.hidden';

  let stage = null;
  let hit = null;
  let video = null;
  let canvas = null;
  let ctx = null;
  let restoreBtn = null;
  let active = null;
  let desired = 'idle';
  let minimized = false;
  let sheetImg = null;
  let sheetFor = '';
  let frameTimer = 0;
  let sheetPlaying = false;
  try { minimized = sessionStorage.getItem(HIDE_KEY) === '1'; } catch (e) {}

  function reduceMotion() {
    return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function mount() {
    stage = document.createElement('div');
    stage.id = 'presenter';
    stage.className = 'presenter';
    stage.hidden = true;
    hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'presenter-hit';
    hit.id = 'presenterHit';
    canvas = document.createElement('canvas');
    canvas.id = 'presenterSheet';
    canvas.hidden = true;
    video = document.createElement('video');
    video.id = 'presenterVideo';
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute('muted', '');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.loop = true;
    video.preload = 'none';
    video.setAttribute('disablepictureinpicture', '');
    video.tabIndex = -1;
    video.hidden = true;
    hit.append(canvas, video);
    stage.append(hit);

    restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.id = 'presenterRestore';
    restoreBtn.className = 'presenter-restore';
    restoreBtn.hidden = true;

    hit.addEventListener('click', minimize);
    restoreBtn.addEventListener('click', restore);
    document.body.append(stage, restoreBtn);
    document.addEventListener('visibilitychange', function () {
      if (!active || minimized) return;
      const spec = PRESENTERS[active];
      if (spec && spec.sheet) {
        if (document.visibilityState !== 'visible') stopSheet();
        else applyMotion();
        return;
      }
      if (!video || !video.getAttribute('src')) return;
      if (document.visibilityState !== 'visible') video.pause();
      else applyMotion();
    });
  }

  function known(id) {
    const spec = id && PRESENTERS[id];
    return !!(spec && (spec.sheet || spec.mp4));
  }

  function stopSheet() {
    if (frameTimer) cancelAnimationFrame(frameTimer);
    frameTimer = 0;
    sheetPlaying = false;
  }

  function drawSheetFrame(spec, index) {
    if (!canvas || !ctx || !sheetImg || !sheetImg.complete || !sheetImg.naturalWidth) return;
    const fw = spec.frameWidth;
    const fh = spec.frameHeight;
    const frame = ((index % spec.frames) + spec.frames) % spec.frames;
    const col = frame % spec.cols;
    const row = Math.floor(frame / spec.cols);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sheetImg, col * fw, row * fh, fw, fh, 0, 0, canvas.width, canvas.height);
  }

  function holdSheet(spec) {
    stopSheet();
    const index = reduceMotion() ? 0 : (Number.isFinite(spec.idleFrame) ? spec.idleFrame : 0);
    drawSheetFrame(spec, index);
  }

  function playSheet(spec) {
    stopSheet();
    if (desired !== 'speaking' || minimized || reduceMotion()) {
      holdSheet(spec);
      return;
    }
    const fps = spec.fps || 8;
    const t0 = performance.now();
    sheetPlaying = true;
    const step = function (now) {
      if (!sheetPlaying || !active || desired !== 'speaking' || minimized) return;
      const index = Math.floor((now - t0) / (1000 / fps)) % spec.frames;
      drawSheetFrame(spec, index);
      frameTimer = requestAnimationFrame(step);
    };
    frameTimer = requestAnimationFrame(step);
  }

  function ensureSheet(spec) {
    canvas.hidden = false;
    video.hidden = true;
    if (video.getAttribute('src')) {
      try { video.pause(); } catch (e) {}
    }
    if (canvas.width !== spec.frameWidth || canvas.height !== spec.frameHeight) {
      canvas.width = spec.frameWidth;
      canvas.height = spec.frameHeight;
      ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
    }
    if (!ctx) ctx = canvas.getContext('2d');
    if (!sheetImg || sheetFor !== spec.sheet) {
      sheetFor = spec.sheet;
      sheetImg = new Image();
      sheetImg.decoding = 'async';
      sheetImg.onload = function () {
        if (active && PRESENTERS[active] && PRESENTERS[active].sheet === sheetFor) playSheet(PRESENTERS[active]);
      };
      sheetImg.src = spec.sheet;
      return;
    }
    if (sheetImg.complete) playSheet(spec);
  }

  function applyMotion() {
    if (!active || minimized) return;
    const spec = PRESENTERS[active];
    if (!spec) return;
    if (stage) stage.dataset.state = desired;
    if (spec.sheet) {
      if (desired === 'speaking' && sheetPlaying) return;
      playSheet(spec);
      return;
    }
    if (!video || !video.getAttribute('src')) return;
    video.dataset.state = desired;
    if (desired === 'speaking') {
      video.playbackRate = 1;
      const pending = video.play();
      if (pending && pending.catch) pending.catch(function () {});
    } else video.pause();
  }

  function ensureSrc(spec) {
    stopSheet();
    canvas.hidden = true;
    video.hidden = false;
    if (video.dataset.coach === active && video.getAttribute('src')) return;
    video.dataset.coach = active;
    video.poster = spec.poster || '';
    video.preload = 'none';
    video.src = spec.mp4;
  }

  function show(id) {
    if (!known(id)) return;
    if (!stage) mount();
    const spec = PRESENTERS[id];
    active = id;
    hit.setAttribute('aria-label', 'Hide ' + spec.label);
    restoreBtn.textContent = spec.label;
    restoreBtn.setAttribute('aria-label', 'Show ' + spec.label);
    restoreBtn.dataset.state = desired;
    if (minimized) {
      stopSheet();
      if (video && !video.paused) video.pause();
      stage.hidden = true;
      restoreBtn.hidden = false;
      return;
    }
    restoreBtn.hidden = true;
    stage.hidden = false;
    if (spec.sheet) ensureSheet(spec);
    else {
      ensureSrc(spec);
      applyMotion();
    }
  }

  function hide() {
    active = null;
    desired = 'idle';
    stopSheet();
    if (!stage) return;
    if (video && !video.paused) video.pause();
    stage.hidden = true;
    stage.dataset.state = 'idle';
    restoreBtn.hidden = true;
  }

  function setState(state) {
    desired = state || 'idle';
    if (restoreBtn) restoreBtn.dataset.state = desired;
    if (stage) stage.dataset.state = desired;
    applyMotion();
  }

  function minimize() {
    minimized = true;
    try { sessionStorage.setItem(HIDE_KEY, '1'); } catch (e) {}
    if (!active) { hide(); return; }
    stopSheet();
    if (video) video.pause();
    if (stage) stage.hidden = true;
    if (restoreBtn) {
      restoreBtn.hidden = false;
      restoreBtn.dataset.state = desired;
    }
  }

  function restore() {
    minimized = false;
    try { sessionStorage.removeItem(HIDE_KEY); } catch (e) {}
    if (active) show(active);
  }

  let once = null;
  let onceVideo = null;
  let onceTimer = null;
  let onceFinish = null;

  function mountOnce() {
    once = document.createElement('div');
    once.id = 'approachFrame';
    once.className = 'approach-frame';
    once.hidden = true;
    onceVideo = document.createElement('video');
    onceVideo.muted = true;
    onceVideo.defaultMuted = true;
    onceVideo.setAttribute('muted', '');
    onceVideo.playsInline = true;
    onceVideo.setAttribute('playsinline', '');
    onceVideo.setAttribute('webkit-playsinline', '');
    onceVideo.preload = 'none';
    onceVideo.loop = false;
    const cap = document.createElement('span');
    cap.className = 'approach-cap';
    cap.textContent = 'Skip';
    once.append(onceVideo, cap);
    once.addEventListener('click', function () { if (onceFinish) onceFinish(); });
    document.body.append(once);
  }
  function stopOnce() {
    if (onceFinish) onceFinish();
  }
  function playOnce(spec) {
    return new Promise(function (resolve) {
      if (!spec || !spec.mp4) { resolve(false); return; }
      if (!once) mountOnce();
      stopOnce();
      once.hidden = false;
      if (onceVideo.getAttribute('src') !== spec.mp4) {
        onceVideo.poster = spec.poster || '';
        onceVideo.preload = 'none';
        onceVideo.src = spec.mp4;
      }
      try { onceVideo.currentTime = 0; } catch (e) {}
      let settled = false;
      const finish = function () {
        if (settled) return;
        settled = true;
        clearTimeout(onceTimer);
        onceVideo.onended = null;
        try { onceVideo.pause(); } catch (e) {}
        if (once) once.hidden = true;
        if (onceFinish === finish) onceFinish = null;
        resolve(true);
      };
      onceFinish = finish;
      onceVideo.onended = finish;
      onceTimer = setTimeout(finish, spec.maxMs > 0 ? spec.maxMs : 3400);
      const pending = onceVideo.play();
      if (pending && pending.catch) pending.catch(function () { finish(); });
    });
  }

  root.BrimPresenter = {
    register: function (id, spec) { if (id && spec && (spec.mp4 || spec.sheet)) PRESENTERS[id] = spec; },
    known: known,
    show: show,
    hide: hide,
    setState: setState,
    minimize: minimize,
    restore: restore,
    current: function () { return active; },
    playOnce: playOnce,
    stopOnce: stopOnce
  };
})(window);
