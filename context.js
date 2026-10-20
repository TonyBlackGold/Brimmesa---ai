// Shared real-world context for every coach. Device clock, Open-Meteo, local US
// observances (Nager.Date when it answers), and the Wikipedia current-events feed.
// No API key. Missing facts stay UNKNOWN. Coaches must not fill the gap.
(function (root) {
  const KEY = 'brimmesa.context.v1';
  const WEATHER_TTL = 30 * 60 * 1000;
  const NEWS_TTL = 4 * 60 * 60 * 1000;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function iso(y, m, d) {
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function nthWeekday(year, monthIndex, weekday, n) {
    const first = new Date(year, monthIndex, 1);
    const delta = (weekday - first.getDay() + 7) % 7;
    return iso(year, monthIndex + 1, 1 + delta + (n - 1) * 7);
  }
  function lastWeekday(year, monthIndex, weekday) {
    const last = new Date(year, monthIndex + 1, 0);
    const delta = (last.getDay() - weekday + 7) % 7;
    return iso(year, monthIndex + 1, last.getDate() - delta);
  }
  function localHolidays(year) {
    return [
      { date: iso(year, 1, 1), name: "New Year's Day" },
      { date: nthWeekday(year, 0, 1, 3), name: 'Martin Luther King Jr. Day' },
      { date: nthWeekday(year, 1, 1, 3), name: "Presidents' Day" },
      { date: lastWeekday(year, 4, 1), name: 'Memorial Day' },
      { date: iso(year, 6, 19), name: 'Juneteenth' },
      { date: iso(year, 7, 4), name: 'Independence Day' },
      { date: nthWeekday(year, 8, 1, 1), name: 'Labor Day' },
      { date: nthWeekday(year, 9, 1, 2), name: 'Columbus Day' },
      { date: iso(year, 11, 11), name: 'Veterans Day' },
      { date: nthWeekday(year, 10, 4, 4), name: 'Thanksgiving' },
      { date: iso(year, 12, 25), name: 'Christmas' },
      { date: iso(year, 12, 31), name: "New Year's Eve" }
    ];
  }
  function clockFrom(ts) {
    const d = new Date(ts);
    const month = d.getMonth();
    const season = month < 2 || month === 11 ? 'winter' : month < 5 ? 'spring' : month < 8 ? 'summer' : 'autumn';
    const hour = d.getHours();
    const h12 = hour % 12 || 12;
    return {
      tag: 'LIVE',
      source: 'device clock',
      iso: iso(d.getFullYear(), month + 1, d.getDate()),
      weekday: WEEKDAYS[d.getDay()],
      dateLabel: WEEKDAYS[d.getDay()] + ', ' + MONTHS[month] + ' ' + d.getDate() + ', ' + d.getFullYear(),
      timeLabel: h12 + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (hour >= 12 ? 'PM' : 'AM'),
      season: season,
      year: d.getFullYear()
    };
  }
  function skyText(code) {
    const c = Number(code);
    if (!Number.isFinite(c)) return '';
    if (c === 0) return 'clear';
    if (c === 1) return 'mainly clear';
    if (c === 2) return 'partly cloudy';
    if (c === 3) return 'overcast';
    if (c === 45 || c === 48) return 'foggy';
    if (c >= 51 && c <= 57) return 'drizzling';
    if (c >= 61 && c <= 67) return 'raining';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snowing';
    if (c >= 80 && c <= 82) return 'showery';
    if (c >= 95) return 'stormy';
    return '';
  }
  function addDays(isoDate, days) {
    const p = isoDate.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + days);
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  function holidayView(list, today) {
    const names = {};
    (list || []).forEach(h => { names[h.date] = h.name; });
    const todayName = names[today] || '';
    const near = [];
    for (let i = -3; i <= 3; i++) {
      if (!i) continue;
      const date = addDays(today, i);
      if (names[date]) near.push({ date: date, name: names[date], days: i });
    }
    return {
      tag: 'LIVE',
      source: 'US observances, computed on this device',
      today: todayName,
      near: near,
      list: list || []
    };
  }
  function stripHtml(html) {
    return String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function storyDate(html, feedIso) {
    const m = String(html || '').match(/<!--\s*([A-Za-z]+)\s+(\d{1,2})\s*-->/);
    if (!m) return feedIso;
    const month = MONTHS.findIndex(name => name.slice(0, 3).toLowerCase() === m[1].slice(0, 3).toLowerCase());
    const year = Number(String(feedIso || '').slice(0, 4)) || new Date().getFullYear();
    if (month < 0) return feedIso;
    return iso(year, month + 1, Number(m[2]));
  }
  function asksWeather(t) { return /\b(weather|forecast|temperature|raining|rain|snowing|humid)\b/i.test(t); }
  function asksWhen(t) { return /\b(what time|what day is it|what day is today|what is today|what's today|today's date|what is the date)\b/i.test(t); }
  function asksHoliday(t) { return /\b(holiday|thanksgiving|christmas|new year|juneteenth|memorial day|labor day|independence day|veterans day)\b/i.test(t); }
  function asksNews(t) { return /\b(headlines|current events|the news|in the news)\b/i.test(t); }
  function asks(text) {
    const t = String(text || '');
    return asksWeather(t) || asksWhen(t) || asksHoliday(t) || asksNews(t);
  }
  function leadStory(snap) {
    const news = snap && snap.news;
    if (!news || news.tag !== 'LIVE' || !news.items || !news.items.length) return null;
    return news.items[0];
  }
  function affairsLine(story) {
    if (!story) return "I don't have a live story on this device. I will not invent one. This is a skill drill, not a report. A friend says everyone agrees the city should ban weekend parking downtown. What was reported, what is a judgment, and who was left out?";
    const bit = String(story.summary || '').slice(0, 280);
    return 'Reporting, not an opinion column. ' + (story.source || 'Wikipedia') + ', ' + (story.published || 'date unknown') + '. ' + bit + ' Source: ' + (story.url || 'https://en.wikipedia.org/wiki/Portal:Current_events') + '. I do not have a separate opinion piece. Summarize the reported fact in one sentence. Then offer one opinion a person might add, and label it opinion.';
  }
  function answerFrom(text, snap) {
    const t = String(text || '');
    const s = snap || {};
    if (asksWeather(t)) {
      const w = s.weather;
      if (!w || w.tag !== 'LIVE') return "I don't have the weather. Add a city in Settings, allow this device, or leave location off. I won't guess.";
      return w.summary + ' Source: ' + (w.source || 'Open-Meteo') + '.';
    }
    if (asksWhen(t)) {
      const c = s.clock;
      if (!c || c.tag !== 'LIVE') return "I don't have the date from this device. I won't guess it.";
      return c.dateLabel + ', ' + c.timeLabel + ', ' + c.season + '. That is the clock on this device.';
    }
    if (asksHoliday(t)) {
      const h = s.holidays;
      if (!h || h.tag !== 'LIVE') return "I don't have the holiday calendar. I won't guess a date.";
      const want = /thanksgiving/i.test(t) ? 'Thanksgiving' : /christmas/i.test(t) ? 'Christmas' : /new year/i.test(t) ? "New Year's Day" : '';
      if (want) {
        const hit = (h.list || []).find(item => item.name.indexOf(want.replace(" Day", '')) === 0 || item.name === want);
        if (hit && hit.date === (s.clock && s.clock.iso)) return 'Today is ' + hit.name + '. Source: ' + h.source + '.';
        if (hit) return hit.name + ' falls on ' + hit.date + ' this year. Source: ' + h.source + '.';
      }
      if (h.today) return 'Today is ' + h.today + '. Source: ' + h.source + '.';
      return 'No US observance I track falls on today. Source: ' + h.source + '.';
    }
    if (asksNews(t)) {
      const story = leadStory(s);
      if (!story) return "I don't have a live story. I won't invent one. Open Current Affairs and I will try the Wikipedia feed, or we can run the skill drill.";
      return 'Reporting, not opinion. ' + story.source + ', ' + story.published + '. ' + String(story.summary || '').slice(0, 220) + ' Source: ' + story.url;
    }
    return '';
  }
  function asideFrom(snap) {
    const h = snap && snap.holidays;
    if (!h || h.tag !== 'LIVE' || !h.today) return '';
    return "It's " + h.today + ' today.';
  }
  function promptFrom(snap) {
    const s = snap || {};
    const c = s.clock;
    const w = s.weather || { tag: 'UNKNOWN', reason: 'not loaded' };
    const h = s.holidays || { tag: 'UNKNOWN' };
    const n = s.news || { tag: 'UNKNOWN', reason: 'not loaded' };
    const lines = [
      'Real-world context. LIVE was fetched or computed. UNKNOWN is missing. Never invent weather, a date, a holiday, or a news event. If a tag is UNKNOWN, say you do not have that fact. Use a LIVE fact only when it fits the moment. Do not give a weather report in a greeting.'
    ];
    lines.push(c && c.tag === 'LIVE'
      ? 'CLOCK LIVE: ' + c.dateLabel + ', ' + c.timeLabel + ', ' + c.season + '. Source: ' + c.source + '.'
      : 'CLOCK UNKNOWN.');
    lines.push(w.tag === 'LIVE'
      ? 'WEATHER LIVE: ' + w.summary + ' Source: ' + (w.source || 'Open-Meteo') + '.'
      : 'WEATHER UNKNOWN: ' + (w.reason || 'not loaded') + '.');
    if (h.tag === 'LIVE') {
      const near = (h.near || []).map(item => item.name + ' ' + item.date).join('; ');
      lines.push('HOLIDAYS LIVE. Today: ' + (h.today || 'none') + '. Within three days: ' + (near || 'none') + '. Source: ' + h.source + '.');
    } else lines.push('HOLIDAYS UNKNOWN.');
    if (n.tag === 'LIVE' && n.items && n.items.length) {
      const story = n.items[0];
      lines.push('NEWS LIVE kind reporting, not opinion. ' + story.source + ', ' + story.published + '. ' + String(story.summary || '').slice(0, 240) + ' Source: ' + story.url + '. Do not add events that are not in this note.');
    } else lines.push('NEWS UNKNOWN: ' + (n.reason || 'not loaded') + '. Do not mention a story.');
    return lines.join('\n');
  }

  function createContext(opts) {
    const o = opts || {};
    const storage = o.storage || { get: function () { return null; }, set: function () {} };
    const fetchImpl = o.fetch || null;
    const nowFn = o.now || function () { return Date.now(); };
    const locate = o.locate || null;
    function read() {
      try {
        const saved = JSON.parse(storage.get() || 'null');
        if (saved && typeof saved === 'object') return saved;
      } catch (e) {}
      return {};
    }
    function write(data) { try { storage.set(JSON.stringify(data)); } catch (e) {} }
    function clock() { return clockFrom(nowFn()); }
    function holidays() {
      const today = clock().iso;
      const year = clock().year;
      const bag = read();
      let list = localHolidays(year);
      let source = 'US observances, computed on this device';
      if (bag.holidays && bag.holidays.year === year && Array.isArray(bag.holidays.list) && bag.holidays.list.length) {
        list = bag.holidays.list;
        source = bag.holidays.source || source;
      }
      const view = holidayView(list, today);
      view.source = source;
      return view;
    }
    function weatherCached() {
      const bag = read();
      const place = bag.place || null;
      if (!place || place.mode === 'declined') return { tag: 'UNKNOWN', reason: place && place.mode === 'declined' ? 'location declined' : 'no location chosen' };
      const hit = bag.weather;
      if (hit && hit.data && hit.data.tag === 'LIVE' && nowFn() - hit.at < WEATHER_TTL) return hit.data;
      return { tag: 'UNKNOWN', reason: 'weather not loaded yet' };
    }
    function newsCached() {
      const bag = read();
      const hit = bag.news;
      if (hit && hit.data && hit.data.tag === 'LIVE' && nowFn() - hit.at < NEWS_TTL) return hit.data;
      return { tag: 'UNKNOWN', reason: 'news not loaded' };
    }
    function snapshot() {
      return { clock: clock(), holidays: holidays(), weather: weatherCached(), news: newsCached(), place: (read().place || null) };
    }
    async function refreshHolidays() {
      const year = clock().year;
      const bag = read();
      if (bag.holidays && bag.holidays.year === year && Array.isArray(bag.holidays.list) && bag.holidays.list.length) return holidays();
      const local = localHolidays(year);
      let list = local;
      let source = 'US observances, computed on this device';
      if (fetchImpl) {
        try {
          const res = await fetchImpl('https://date.nager.at/api/v3/PublicHolidays/' + year + '/US');
          if (res && res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length) {
              list = rows.map(row => ({ date: row.date, name: row.localName || row.name })).filter(row => row.date && row.name);
              source = 'Nager.Date';
            }
          }
        } catch (e) {}
      }
      if (!list.length) list = local;
      bag.holidays = { year: year, at: nowFn(), list: list, source: source };
      write(bag);
      return holidays();
    }
    async function refreshWeather() {
      const bag = read();
      const place = bag.place;
      if (!place || place.mode === 'declined' || place.lat == null || place.lon == null) return weatherCached();
      if (!fetchImpl) return weatherCached();
      try {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(place.lat) + '&longitude=' + encodeURIComponent(place.lon) + '&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto';
        const res = await fetchImpl(url);
        if (!res || !res.ok) throw new Error('weather');
        const data = await res.json();
        const current = data.current || {};
        const sky = skyText(current.weather_code);
        const temp = Number(current.temperature_2m);
        if (!Number.isFinite(temp) && !sky) throw new Error('empty');
        const where = place.name || 'this device';
        const summary = (Number.isFinite(temp) ? Math.round(temp) + ' F' : 'conditions unavailable') + (sky ? ' and ' + sky : '') + ' in ' + where;
        const live = { tag: 'LIVE', source: 'Open-Meteo', summary: summary, place: where, at: current.time || '' };
        bag.weather = { at: nowFn(), data: live };
        write(bag);
        return live;
      } catch (e) {
        return { tag: 'UNKNOWN', reason: 'Open-Meteo did not answer' };
      }
    }
    async function refreshNews() {
      if (!fetchImpl) return newsCached();
      const c = clock();
      const parts = c.iso.split('-');
      const url = 'https://en.wikipedia.org/api/rest_v1/feed/featured/' + parts[0] + '/' + parts[1] + '/' + parts[2];
      try {
        const res = await fetchImpl(url);
        if (!res || !res.ok) throw new Error('news');
        const data = await res.json();
        const rows = Array.isArray(data.news) ? data.news : [];
        const items = rows.slice(0, 3).map(row => {
          const links = row.links || [];
          const page = links[0] && links[0].content_urls && links[0].content_urls.desktop && links[0].content_urls.desktop.page;
          return {
            tag: 'LIVE',
            kind: 'reporting',
            source: 'Wikipedia',
            published: storyDate(row.story, c.iso),
            url: page || 'https://en.wikipedia.org/wiki/Portal:Current_events',
            summary: stripHtml(row.story).slice(0, 360)
          };
        }).filter(item => item.summary);
        if (!items.length) return { tag: 'UNKNOWN', reason: 'Wikipedia feed had no stories' };
        const live = { tag: 'LIVE', source: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Portal:Current_events', published: c.iso, items: items };
        const bag = read();
        bag.news = { at: nowFn(), data: live };
        write(bag);
        return live;
      } catch (e) {
        return { tag: 'UNKNOWN', reason: 'Wikipedia feed did not answer' };
      }
    }
    async function useCity(name) {
      const city = String(name || '').trim();
      if (!city) return snapshot();
      if (!fetchImpl) return snapshot();
      const res = await fetchImpl('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' + encodeURIComponent(city));
      if (!res || !res.ok) throw new Error('geocode');
      const data = await res.json();
      const hit = data.results && data.results[0];
      if (!hit) throw new Error('missing');
      const bag = read();
      bag.place = { mode: 'city', name: hit.name + (hit.admin1 ? ', ' + hit.admin1 : ''), lat: hit.latitude, lon: hit.longitude };
      bag.weather = null;
      write(bag);
      await refreshWeather();
      return snapshot();
    }
    async function useDevice() {
      if (!locate) throw new Error('no geolocation');
      const pos = await locate();
      const bag = read();
      bag.place = { mode: 'device', name: 'this device', lat: pos.lat, lon: pos.lon };
      bag.weather = null;
      write(bag);
      await refreshWeather();
      return snapshot();
    }
    function decline() {
      const bag = read();
      bag.place = { mode: 'declined' };
      bag.weather = null;
      write(bag);
      return snapshot();
    }
    async function ensure(flags) {
      const f = flags || {};
      if (f.holidays !== false) await refreshHolidays();
      const place = read().place;
      if (f.weather !== false && place && place.mode !== 'declined' && place.lat != null) {
        const cached = weatherCached();
        if (cached.tag !== 'LIVE') await refreshWeather();
      }
      if (f.news) {
        const cached = newsCached();
        if (cached.tag !== 'LIVE') await refreshNews();
      }
      return snapshot();
    }
    return {
      clock: clock,
      holidays: holidays,
      snapshot: snapshot,
      ensure: ensure,
      useCity: useCity,
      useDevice: useDevice,
      decline: decline,
      prompt: function () { return promptFrom(snapshot()); },
      answer: function (text, snap) { return answerFrom(text, snap || snapshot()); },
      aside: function (snap) { return asideFrom(snap || snapshot()); },
      asks: asks,
      asksNews: asksNews,
      leadStory: function (snap) { return leadStory(snap || snapshot()); },
      affairsLine: affairsLine
    };
  }

  const api = { createContext, localHolidays, clockFrom, skyText, holidayView, asks, asksNews, affairsLine, answerFrom, promptFrom, asideFrom, leadStory, stripHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BrimContext = createContext({
    storage: {
      get: function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
      set: function (v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
    },
    fetch: function (url) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 6000);
      return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).finally(function () { clearTimeout(timer); });
    },
    now: function () { return Date.now(); },
    locate: function () {
      return new Promise(function (resolve, reject) {
        if (!navigator.geolocation) { reject(new Error('no geolocation')); return; }
        navigator.geolocation.getCurrentPosition(function (pos) {
          resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        }, reject, { enableHighAccuracy: false, timeout: 8000, maximumAge: WEATHER_TTL });
      });
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
