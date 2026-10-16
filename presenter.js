// Miniature full-body presenter. Add another coach with BrimPresenter.register(id, { label, mp4, poster }).
// The video file is not requested until that coach is actually shown.
(function (root) {
  const PRESENTERS = {
    amara: {
      label: 'Amara',
      mp4: 'assets/amara-full.mp4',
      poster: 'assets/amara-full-poster.webp'
    }
  };
  const HIDE_KEY = 'brimmesa.presenter.hidden';

  let stage = null;
  let hit = null;
  let video = null;
  let restoreBtn = null;
  let active = null;
  let desired = 'idle';
  let minimized = false;
  try { minimized = sessionStorage.getItem(HIDE_KEY) === '1'; } catch (e) {}

  function mount() {
    stage = document.createElement('div');
    stage.id = 'presenter';
    stage.className = 'presenter';
    stage.hidden = true;
    hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'presenter-hit';
    hit.id = 'presenterHit';
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
    hit.append(video);
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
      if (!video || !active || minimized) return;
      if (document.visibilityState !== 'visible') video.pause();
      else applyMotion();
    });
  }

  function known(id) { return !!(id && PRESENTERS[id] && PRESENTERS[id].mp4); }

  function applyMotion() {
    if (!video || !active || minimized || !video.getAttribute('src')) return;
    video.dataset.state = desired;
    if (stage) stage.dataset.state = desired;
    if (desired === 'speaking') {
      video.playbackRate = 1;
      const pending = video.play();
      if (pending && pending.catch) pending.catch(function () {});
    } else video.pause();
  }

  function ensureSrc(spec) {
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
      if (!video.paused) video.pause();
      stage.hidden = true;
      restoreBtn.hidden = false;
      return;
    }
    restoreBtn.hidden = true;
    stage.hidden = false;
    ensureSrc(spec);
    applyMotion();
  }

  function hide() {
    active = null;
    desired = 'idle';
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
    register: function (id, spec) { if (id && spec && spec.mp4) PRESENTERS[id] = spec; },
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
