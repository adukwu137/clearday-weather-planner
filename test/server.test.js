'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, loadConfig } = require('../server');
const { makeForecast, makeAir } = require('./fixtures');

function startMockUpstream() {
  const state = {
    calls: { geo: 0, forecast: 0, air: 0 },
    fail: { geo: false, forecast: false, air: false },
    lastQuery: {},
    forecastBody: null,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const name = url.pathname.slice(1);
    state.calls[name] += 1;
    state.lastQuery[name] = Object.fromEntries(url.searchParams);
    if (state.fail[name]) {
      res.writeHead(500);
      return res.end('boom');
    }
    res.setHeader('Content-Type', 'application/json');
    if (name === 'geo') {
      const found = url.searchParams.get('name').toLowerCase() === 'kigali';
      return res.end(JSON.stringify(found
        ? { results: [{ id: 1, name: 'Kigali', admin1: 'Kigali', country: 'Rwanda', country_code: 'RW', latitude: -1.94, longitude: 30.06, timezone: 'Africa/Kigali' }, { id: 2, name: 'Broken', latitude: 'x' }] }
        : { generationtime_ms: 0.4 }));
    }
    if (name === 'forecast') return res.end(JSON.stringify(state.forecastBody ?? makeForecast()));
    return res.end(JSON.stringify(makeAir()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

async function startApp(overrides = {}) {
  const mock = await startMockUpstream();
  const config = {
    ...loadConfig({}), port: 0, host: '127.0.0.1', serverName: 'test-web', logRequests: false,
    geocodingUrl: `${mock.url}/geo`, forecastUrl: `${mock.url}/forecast`, airQualityUrl: `${mock.url}/air`,
    upstreamTimeoutMs: 2000, ...overrides,
  };
  const server = createServer(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    mock,
    async close() {
      server.close();
      mock.server.close();
    },
  };
}

const getJson = async (url) => {
  const res = await fetch(url);
  return { res, body: await res.json() };
};

test('health route reports the server name', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { res, body } = await getJson(`${app.base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.server, 'test-web');
  assert.equal(res.headers.get('x-served-by'), 'test-web');
});

test('search returns cleaned results and sends the right upstream parameters', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { res, body } = await getJson(`${app.base}/api/search?q=Kigali`);
  assert.equal(res.status, 200);
  assert.equal(body.results.length, 1, 'entries without valid coordinates are dropped');
  assert.equal(body.results[0].name, 'Kigali');
  assert.equal(body.results[0].countryCode, 'RW');
  assert.equal(app.mock.state.lastQuery.geo.name, 'Kigali');
  assert.equal(app.mock.state.lastQuery.geo.count, '6');
});

test('search with no match returns an empty list', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { res, body } = await getJson(`${app.base}/api/search?q=Zzzzzz`);
  assert.equal(res.status, 200);
  assert.deepEqual(body.results, []);
});

test('search validates input', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const query of ['', '?q=', '?q=a', `?q=${'x'.repeat(80)}`, '?q=%00%01']) {
    const { res, body } = await getJson(`${app.base}/api/search${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(body.error.code, 'invalid_query');
  }
});

test('weather returns the report and calls Open-Meteo with the expected parameters', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const { res, body } = await getJson(`${app.base}/api/weather?lat=-1.94&lon=30.06`);
  assert.equal(res.status, 200);
  assert.equal(body.daily.length, 7);
  assert.equal(body.air.aqi, 42);
  assert.equal(body.meta.servedBy, 'test-web');
  assert.equal(body.meta.weatherStale, false);
  assert.equal(body.meta.airAvailable, true);

  const forecast = app.mock.state.lastQuery.forecast;
  assert.equal(forecast.latitude, '-1.94');
  assert.equal(forecast.longitude, '30.06');
  assert.equal(forecast.timezone, 'auto');
  assert.equal(forecast.forecast_days, '7');
  assert.match(forecast.current, /temperature_2m/);
  assert.match(forecast.daily, /uv_index_max/);
  assert.match(forecast.daily, /sunrise/);
  const air = app.mock.state.lastQuery.air;
  assert.match(air.current, /us_aqi/);
  assert.equal(air.hourly, 'us_aqi');
});

test('repeated requests are served from the cache', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await getJson(`${app.base}/api/weather?lat=-1.94&lon=30.06`);
  await getJson(`${app.base}/api/weather?lat=-1.94&lon=30.06`);
  await getJson(`${app.base}/api/weather?lat=-1.9401&lon=30.0599`);
  assert.equal(app.mock.state.calls.forecast, 1);
  assert.equal(app.mock.state.calls.air, 1);
});

test('simultaneous requests share one upstream call', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await Promise.all(Array.from({ length: 5 }, () => getJson(`${app.base}/api/weather?lat=10&lon=20`)));
  assert.equal(app.mock.state.calls.forecast, 1);
});

test('weather validates coordinates', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const query of ['', '?lat=abc&lon=1', '?lat=91&lon=1', '?lat=1&lon=181', '?lat=1', '?lat=1e1&lon=2', '?lat=0x10&lon=2']) {
    const { res, body } = await getJson(`${app.base}/api/weather${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(body.error.code, 'invalid_coordinates');
  }
});

test('weather still works when only air quality fails', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  app.mock.state.fail.air = true;
  const { res, body } = await getJson(`${app.base}/api/weather?lat=1&lon=2`);
  assert.equal(res.status, 200);
  assert.equal(body.air, null);
  assert.equal(body.meta.airAvailable, false);
  assert.equal(body.daily.length, 7);
});

test('saved data is served and flagged when the upstream fails later', async (t) => {
  const app = await startApp({ cacheTtlMs: 1 });
  t.after(() => app.close());
  const first = await getJson(`${app.base}/api/weather?lat=3&lon=4`);
  assert.equal(first.body.meta.weatherStale, false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  app.mock.state.fail.forecast = true;
  app.mock.state.fail.air = true;
  const second = await getJson(`${app.base}/api/weather?lat=3&lon=4`);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.meta.weatherStale, true);
  assert.equal(second.body.meta.airStale, true);
  assert.equal(second.body.daily.length, 7);
});

test('returns a clear 503 when the upstream fails and nothing is saved', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  app.mock.state.fail.forecast = true;
  const { res, body } = await getJson(`${app.base}/api/weather?lat=5&lon=6`);
  assert.equal(res.status, 503);
  assert.equal(body.error.code, 'weather_unavailable');
  assert.ok(body.error.message.length > 20);
  assert.equal(res.headers.get('retry-after'), '60');
});

test('rejects malformed upstream data', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  app.mock.state.forecastBody = { unexpected: true };
  const { res, body } = await getJson(`${app.base}/api/weather?lat=7&lon=8`);
  assert.equal(res.status, 503);
  assert.equal(body.error.code, 'weather_unavailable');
});

test('rate limits API requests per client', async (t) => {
  const app = await startApp({ rateLimitPerMinute: 3 });
  t.after(() => app.close());
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await fetch(`${app.base}/api/health`)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  const limited = await fetch(`${app.base}/api/health`);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  const other = await fetch(`${app.base}/api/health`, { headers: { 'X-Real-IP': '203.0.113.9' } });
  assert.equal(other.status, 200, 'a different client has its own allowance');
});

test('unknown API routes and non-GET methods are rejected', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  assert.equal((await fetch(`${app.base}/api/nothing`)).status, 404);
  const post = await fetch(`${app.base}/api/search?q=Kigali`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('serves the frontend, clean URLs and a 404 page', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const home = await fetch(`${app.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /ClearDay/);
  assert.equal((await fetch(`${app.base}/privacy`)).status, 200);
  assert.equal((await fetch(`${app.base}/terms`)).status, 200);
  const js = await fetch(`${app.base}/js/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  const missing = await fetch(`${app.base}/nope`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Page not found/);
});

test('does not serve files outside the public folder', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  for (const target of ['/..%2f..%2fserver.js', '/%2e%2e/server.js', '/..%2fpackage.json', '/%00']) {
    const res = await fetch(`${app.base}${target}`);
    const text = await res.text();
    assert.ok(res.status === 404 || res.status === 400, `${target} gave ${res.status}`);
    assert.doesNotMatch(text, /createServer|"name": "clearday"/);
  }
});

test('sends security headers', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const res = await fetch(`${app.base}/`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-served-by'), 'test-web');
});
