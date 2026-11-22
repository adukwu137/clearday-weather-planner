'use strict';

(() => {
  const L = window.ClearDayLogic;
  const DEFAULT_LOCATION = { name: 'Kigali', admin1: 'Kigali', country: 'Rwanda', latitude: -1.94, longitude: 30.06 };
  const KEYS = { units: 'clearday.units', favorites: 'clearday.favorites', recent: 'clearday.recent', last: 'clearday.last' };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const state = {
    units: 'metric',
    favorites: [],
    recent: [],
    location: null,
    report: null,
    sort: 'date',
    filter: 'all',
    error: null,
    failed: null,
    requestId: 0,
  };

  const $ = (id) => document.getElementById(id);


  const storage = {
    read(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage full or blocked: ignore */
      }
    },
  };

  const readPlaces = (key) => {
    const value = storage.read(key, []);
    return Array.isArray(value) ? value.filter(L.isValidLocation).map(L.cleanLocation) : [];
  };

  /* ---------- DOM helpers (text only, never innerHTML) ---------- */

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  }

  /* ---------- API ---------- */

  class ApiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function api(route, params) {
    const url = new URL(route, window.location.origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    let response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    } catch (error) {
      const timedOut = error && error.name === 'TimeoutError';
      throw new ApiError('offline', timedOut
        ? 'The server took too long to answer. Try again.'
        : 'Cannot reach the ClearDay server. Check your internet connection and try again.');
    }

    const servedBy = response.headers.get('X-Served-By');
    if (servedBy) $('served-by').textContent = servedBy;

    let body = null;
    try {
      body = await response.json();
    } catch {
      /* non-JSON error page */
    }
    if (!response.ok) {
      throw new ApiError(body?.error?.code ?? 'error', body?.error?.message ?? 'The server sent an unexpected response. Try again.');
    }
    return body;
  }

  /* ---------- notices ---------- */

  function renderNotices() {
    const notices = [];
    if (state.error) {
      notices.push({ kind: 'error', text: state.error, retry: () => loadLocation(state.failed || state.location || DEFAULT_LOCATION) });
    }
    const meta = state.report && state.report.meta;
    if (meta) {
      const ago = (iso) => L.describeAge(L.minutesAgo(iso, Date.now()));
      if (meta.weatherStale) {
        notices.push({ kind: 'warn', text: `The weather service is not responding. Showing saved weather from ${ago(meta.fetchedAt)} ago.` });
      }
      if (!meta.airAvailable) {
        notices.push({ kind: 'warn', text: 'Air quality data is unavailable right now. The weather data is up to date.' });
      } else if (meta.airStale) {
        notices.push({ kind: 'warn', text: `Air quality data is saved from ${ago(meta.airFetchedAt)} ago because the service is not responding.` });
      }
    }
    $('notices').replaceChildren(
      ...notices.map((n) =>
        el('div', { class: `notice ${n.kind}`, role: n.kind === 'error' ? 'alert' : 'status' },
          el('span', { text: n.text }),
          n.retry ? el('button', { class: 'btn', type: 'button', text: 'Retry', onclick: n.retry }) : null)),
    );
  }

  /* ---------- rendering ---------- */

  const temp = (celsius) => L.formatTemp(celsius, state.units);

  function renderCurrent() {
    const { current, sun, daily } = state.report;
    const [date, time] = String(current.time).split('T');
    const saved = L.isFavorite(state.favorites, state.location);
    const todayUv = daily[0] && daily[0].uv !== null ? Math.round(daily[0].uv) : 'n/a';
    const fact = (label, value) => el('div', {}, el('dt', { text: label }), el('dd', { text: value }));

    $('current-body').replaceChildren(
      el('div', { class: 'now' },
        el('div', {},
          el('h1', { text: L.locationLabel(state.location) }),
          el('p', { class: 'muted', text: `${L.weekdayLabel(date, 'long')}, ${(time || '').slice(0, 5)} local time` }),
          el('p', { class: 'big temp', text: temp(current.temperature) }),
          el('p', { class: 'desc', text: `${current.summary}, feels like ${temp(current.feelsLike)}` }),
          el('button', {
            class: 'btn', type: 'button', 'aria-pressed': saved ? 'true' : 'false',
            text: saved ? 'Saved to favorites' : 'Save to favorites', onclick: toggleFavorite,
          })),
        el('dl', { class: 'facts' },
          fact('Humidity', current.humidity === null ? 'n/a' : `${Math.round(current.humidity)}%`),
          fact('Wind', L.formatWind(current.windSpeed, state.units)),
          fact('Rain now', L.formatMm(current.precipitation)),
          fact('UV index today', todayUv),
          fact('Sunrise', sun.sunrise ? sun.sunrise.slice(11, 16) : 'n/a'),
          fact('Sunset', sun.sunset ? sun.sunset.slice(11, 16) : 'n/a'))),
    );
  }

  function renderAir() {
    const { air } = state.report;
    const body = $('air-body');
    if (!air || air.aqi === null) {
      body.replaceChildren(el('p', { class: 'muted', text: 'Air quality is not available for this place right now.' }));
      return;
    }
    const scale = el('div', { class: 'scale', role: 'img', 'aria-label': `US AQI ${air.aqi}, ${air.category}` },
      ...[0, 1, 2, 3, 4, 5].map((i) => el('span', { class: `s${i}` })),
      el('span', { class: 'marker' }));
    scale.querySelector('.marker').style.left = `${L.aqiScalePercent(air.aqi)}%`;

    body.replaceChildren(
      el('div', { class: 'aqi-line' },
        el('span', { class: 'big', text: String(air.aqi) }),
        el('strong', { text: `US AQI, ${air.category}` })),
      scale,
      el('p', { class: 'muted', text: `PM2.5 ${air.pm25 ?? 'n/a'} µg/m³, PM10 ${air.pm10 ?? 'n/a'} µg/m³` }),
    );
  }

  function advisoryText(a) {
    switch (a.type) {
      case 'rain': return { title: 'Heavy rain', detail: `${a.value} mm is forecast. Plan indoor activities.` };
      case 'uv': return { title: 'Extreme UV', detail: `UV index ${a.value}. Cover up and avoid the midday sun.` };
      case 'heat': return { title: 'High heat', detail: `A high of ${temp(a.value)} is forecast. Drink water and rest in the shade.` };
      default: return { title: 'Poor air quality', detail: `US AQI up to ${a.value}. People with breathing problems should limit time outdoors.` };
    }
  }

  function renderAdvisories() {
    const list = state.report.advisories;
    const body = $('advisories-body');
    const note = el('p', { class: 'muted small', text: 'Advisories are calculated from forecast values. They are not official warnings.' });
    if (list.length === 0) {
      body.replaceChildren(el('p', { text: 'No heavy rain, extreme UV, high heat or poor air quality is forecast for the next 7 days.' }), note);
      return;
    }
    body.replaceChildren(
      el('ul', { class: 'advisories' }, ...list.map((a) => {
        const text = advisoryText(a);
        return el('li', {}, el('strong', { text: `${L.weekdayLabel(a.date)}: ${text.title}. ` }), text.detail);
      })),
      note);
  }

  function renderChart() {
    const box = $('chart-body');
    const points = state.report.hourly.filter((h) => h.temp !== null);
    if (points.length < 2) {
      box.replaceChildren(el('p', { class: 'muted', text: 'Hourly temperatures are not available for this place.' }));
      return;
    }
    const W = 640, H = 210, left = 40, right = 14, top = 28, bottom = 30;
    const values = points.map((p) => L.convertTemp(p.temp, state.units));
    const min = Math.floor(Math.min(...values)) - 1;
    const max = Math.ceil(Math.max(...values)) + 1;
    const x = (i) => left + (i / (points.length - 1)) * (W - left - right);
    const y = (v) => top + (1 - (v - min) / (max - min)) * (H - top - bottom);
    const peak = values.indexOf(Math.max(...values));
    const low = values.indexOf(Math.min(...values));
    const hour = (i) => points[i].time.slice(11, 16);

    const chart = svg('svg', {
      viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
      'aria-label': `Hourly temperature today. Lowest ${Math.round(values[low])} degrees at ${hour(low)}, highest ${Math.round(values[peak])} degrees at ${hour(peak)}.`,
    });
    for (const v of [min, (min + max) / 2, max]) {
      chart.append(svg('line', { class: 'grid', x1: left, x2: W - right, y1: y(v), y2: y(v) }));
      const label = svg('text', { x: left - 6, y: y(v) + 4, 'text-anchor': 'end' });
      label.textContent = Math.round(v);
      chart.append(label);
    }
    chart.append(svg('polyline', { class: 'line', points: values.map((v, i) => `${x(i)},${y(v)}`).join(' ') }));
    chart.append(svg('circle', { class: 'dot', cx: x(peak), cy: y(values[peak]), r: 5 }));
    const peakLabel = svg('text', { class: 'peak', x: x(peak), y: y(values[peak]) - 10, 'text-anchor': 'middle' });
    peakLabel.textContent = `${Math.round(values[peak])}°`;
    chart.append(peakLabel);
    points.forEach((p, i) => {
      if (i % 3 !== 0) return;
      const label = svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' });
      label.textContent = hour(i);
      chart.append(label);
    });
    box.replaceChildren(el('div', { class: 'chart-wrap', tabindex: '0', role: 'region', 'aria-label': 'Hourly temperature chart' }, chart));
  }

  function renderForecast() {
    const all = state.report.daily;
    const shown = L.sortDays(L.filterDays(all, state.filter), state.sort);
    const today = String(state.report.current.time).slice(0, 10);
    const num = (v) => (v === null ? 'n/a' : Math.round(v));

    $('forecast-count').textContent = `Showing ${shown.length} of ${all.length} days`;
    if (shown.length === 0) {
      $('forecast-rows').replaceChildren(
        el('tr', {}, el('td', { colspan: 7, text: 'No days match this filter. Choose All days to see the full forecast.' })));
      return;
    }
    $('forecast-rows').replaceChildren(...shown.map((d) =>
      el('tr', {},
        el('th', { scope: 'row' }, L.weekdayLabel(d.date), d.date === today ? el('span', { class: 'tag', text: 'Today' }) : null),
        el('td', { text: d.summary }),
        el('td', { text: `${temp(d.tmax)} / ${temp(d.tmin)}` }),
        el('td', { text: L.formatMm(d.rain) }),
        el('td', { text: num(d.uv) }),
        el('td', { text: d.aqi === null ? 'n/a' : d.aqi }),
        el('td', { class: `rating ${d.rating.toLowerCase()}`, text: d.rating }))));
  }

  function renderPlaces() {
    const build = (items, listId, emptyId, withRemove) => {
      $(emptyId).hidden = items.length > 0;
      $(listId).replaceChildren(...items.map((loc) =>
        el('li', {},
          el('button', { class: 'link', type: 'button', text: L.locationLabel(loc), onclick: () => loadLocation(loc) }),
          withRemove
            ? el('button', { class: 'link remove', type: 'button', text: 'Remove', 'aria-label': `Remove ${loc.name} from favorites`, onclick: () => removeFavorite(loc) })
            : null)));
    };
    build(state.favorites, 'favorites', 'favorites-empty', true);
    build(state.recent, 'recent', 'recent-empty', false);
    $('clear-recent').hidden = state.recent.length === 0;
  }

  function renderUnits() {
    document.querySelectorAll('[data-unit]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === state.units)));
    document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
    $('sort').value = state.sort;
  }

  function renderReport() {
    $('report').hidden = !state.report;
    if (state.report) {
      renderCurrent();
      renderAir();
      renderAdvisories();
      renderChart();
      renderForecast();
      document.title = `${state.location.name}: weather and air quality | ClearDay`;
    }
    renderNotices();
    renderPlaces();
    renderUnits();
  }

  /* ---------- actions ---------- */

  function setLoading(on) {
    $('loading').hidden = !on;
    $('main').setAttribute('aria-busy', String(on));
  }

  async function loadLocation(loc) {
    const requestId = ++state.requestId;
    $('search-results').hidden = true;
    setLoading(true);
    try {
      const report = await api('/api/weather', { lat: loc.latitude, lon: loc.longitude });
      if (requestId !== state.requestId) return;
      state.location = L.cleanLocation(loc);
      state.report = report;
      state.error = null;
      state.failed = null;
      state.recent = L.addRecent(state.recent, loc);
      storage.write(KEYS.recent, state.recent);
      storage.write(KEYS.last, state.location);
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.error = `Could not load the forecast for ${loc.name}. ${error.message}`;
      state.failed = L.cleanLocation(loc);
      if (!state.location) state.location = L.cleanLocation(loc);
    } finally {
      if (requestId === state.requestId) {
        setLoading(false);
        renderReport();
      }
    }
  }

  function toggleFavorite() {
    const result = L.toggleFavorite(state.favorites, state.location);
    state.favorites = result.list;
    storage.write(KEYS.favorites, state.favorites);
    renderCurrent();
    renderPlaces();
  }

  function removeFavorite(loc) {
    state.favorites = state.favorites.filter((f) => L.locationKey(f) !== L.locationKey(loc));
    storage.write(KEYS.favorites, state.favorites);
    if (state.report) renderCurrent();
    renderPlaces();
  }

  function showSearchError(message) {
    const box = $('search-error');
    box.textContent = message || '';
    box.hidden = !message;
    $('city').setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function showResults(query, results) {
    const panel = $('search-results');
    panel.hidden = false;
    if (results.length === 0) {
      $('results-body').replaceChildren(el('p', { text: `No city matches "${query}". Check the spelling or try a larger nearby city.` }));
      return;
    }
    $('results-body').replaceChildren(
      el('ul', { class: 'plain result-list' }, ...results.map((r) =>
        el('li', {}, el('button', { class: 'link', type: 'button', text: L.locationLabel(r), onclick: () => loadLocation(r) })))));
    $('results-body').querySelector('button').focus();
  }

  async function onSearch(event) {
    event.preventDefault();
    const query = $('city').value.replace(/\s+/g, ' ').trim();
    if (query.length < 2) {
      showSearchError('Enter at least 2 characters of a city name.');
      return;
    }
    showSearchError('');
    const button = $('search-btn');
    button.disabled = true;
    button.textContent = 'Searching';
    try {
      const data = await api('/api/search', { q: query });
      if (data.results.length === 1) await loadLocation(data.results[0]);
      else showResults(query, data.results);
    } catch (error) {
      showSearchError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Search';
    }
  }

  /* ---------- start ---------- */

  function init() {
    const units = storage.read(KEYS.units, 'metric');
    state.units = units === 'imperial' ? 'imperial' : 'metric';
    state.favorites = readPlaces(KEYS.favorites);
    state.recent = readPlaces(KEYS.recent);
    const last = storage.read(KEYS.last, null);

    $('search-form').addEventListener('submit', onSearch);
    $('city').addEventListener('input', () => showSearchError(''));
    $('clear-recent').addEventListener('click', () => {
      state.recent = [];
      storage.write(KEYS.recent, state.recent);
      renderPlaces();
    });
    document.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
      state.units = b.dataset.unit;
      storage.write(KEYS.units, state.units);
      renderReport();
    }));
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      if (state.report) renderForecast();
      renderUnits();
    }));
    $('sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      if (state.report) renderForecast();
    });

    renderPlaces();
    renderUnits();
    loadLocation(L.isValidLocation(last) ? last : DEFAULT_LOCATION);
  }

  init();
})();
