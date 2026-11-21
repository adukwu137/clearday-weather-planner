'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { TtlCache } = require('./lib/cache');
const { createClient } = require('./lib/openmeteo');
const { buildReport } = require('./lib/derive');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

function loadConfig(env = process.env) {
  return {
    port: toInt(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    serverName: env.SERVER_NAME || os.hostname(),
    cacheTtlMs: toInt(env.CACHE_TTL_SECONDS, 600) * 1000,
    rateLimitPerMinute: toInt(env.RATE_LIMIT_PER_MINUTE, 120),
    geocodingUrl: env.GEOCODING_URL || 'https://geocoding-api.open-meteo.com/v1/search',
    forecastUrl: env.FORECAST_URL || 'https://api.open-meteo.com/v1/forecast',
    airQualityUrl: env.AIR_QUALITY_URL || 'https://air-quality-api.open-meteo.com/v1/air-quality',
    upstreamTimeoutMs: toInt(env.UPSTREAM_TIMEOUT_MS, 8000),
    logRequests: env.LOG_REQUESTS !== 'false',
  };
}

/* ---------- input validation ---------- */

function cleanQuery(raw) {
  if (typeof raw !== 'string') return null;
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return q.length >= 2 && q.length <= 60 ? q : null;
}

function parseCoordinate(raw, min, max) {
  if (typeof raw !== 'string' || !/^-?\d{1,3}(\.\d{1,8})?$/.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 100) / 100; // about 1 km, which also improves cache hits
}

/* ---------- rate limiting ---------- */

function createRateLimiter(limit, windowMs = 60000) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }, windowMs);
  timer.unref();

  return {
    check(key, now = Date.now()) {
      if (buckets.size > 10000) buckets.clear();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return { allowed: bucket.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/* ---------- responses ---------- */

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { error: { code, message } }, headers);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/* ---------- server ---------- */

function createServer(config) {
  const client = createClient({
    geocodingUrl: config.geocodingUrl,
    forecastUrl: config.forecastUrl,
    airQualityUrl: config.airQualityUrl,
    timeoutMs: config.upstreamTimeoutMs,
  });
  const geoCache = new TtlCache({ ttlMs: 24 * 60 * 60 * 1000, maxStaleMs: 7 * 24 * 60 * 60 * 1000 });
  const weatherCache = new TtlCache({ ttlMs: config.cacheTtlMs });
  const airCache = new TtlCache({ ttlMs: config.cacheTtlMs });
  const limiter = createRateLimiter(config.rateLimitPerMinute);

  function clientKey(req) {
    // Nginx on each web server sets X-Real-IP from the load balancer's X-Forwarded-For.
    const real = req.headers['x-real-ip'];
    return (typeof real === 'string' && real.trim()) || req.socket.remoteAddress || 'unknown';
  }

  async function handleSearch(url, res) {
    const q = cleanQuery(url.searchParams.get('q'));
    if (!q) return sendError(res, 400, 'invalid_query', 'Enter at least 2 characters of a city name.');
    try {
      const hit = await geoCache.getOrFetch(`geo:${q.toLowerCase()}`, () => client.searchCities(q));
      sendJson(res, 200, { query: q, results: hit.value, meta: { stale: hit.stale } });
    } catch (error) {
      console.error(`search failed: ${error.code || error.message}`);
      sendError(res, 503, 'search_unavailable', 'City search is unavailable right now. Try again in a few minutes.', { 'Retry-After': '60' });
    }
  }

  async function handleWeather(url, res) {
    const lat = parseCoordinate(url.searchParams.get('lat'), -90, 90);
    const lon = parseCoordinate(url.searchParams.get('lon'), -180, 180);
    if (lat === null || lon === null) {
      return sendError(res, 400, 'invalid_coordinates', 'Latitude must be between -90 and 90, and longitude between -180 and 180.');
    }

    const key = `${lat},${lon}`;
    const [weather, air] = await Promise.allSettled([
      weatherCache.getOrFetch(`wx:${key}`, () => client.getForecast(lat, lon)),
      airCache.getOrFetch(`aq:${key}`, () => client.getAirQuality(lat, lon)),
    ]);

    if (weather.status === 'rejected') {
      console.error(`forecast failed: ${weather.reason.code || weather.reason.message}`);
      return sendError(res, 503, 'weather_unavailable', 'The weather service is not responding and no saved forecast exists for this place. Try again in a few minutes.', { 'Retry-After': '60' });
    }

    const airHit = air.status === 'fulfilled' ? air.value : null;
    if (!airHit) console.error(`air quality failed: ${air.reason.code || air.reason.message}`);

    const report = buildReport(weather.value.value, airHit ? airHit.value : null);
    report.meta = {
      servedBy: config.serverName,
      fetchedAt: new Date(weather.value.storedAt).toISOString(),
      weatherStale: weather.value.stale,
      airAvailable: airHit !== null,
      airStale: airHit ? airHit.stale : false,
      airFetchedAt: airHit ? new Date(airHit.storedAt).toISOString() : null,
    };
    sendJson(res, 200, report);
  }

  async function handleApi(req, url, res) {
    const limit = limiter.check(clientKey(req));
    if (!limit.allowed) {
      return sendError(res, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.', { 'Retry-After': String(limit.retryAfterSeconds) });
    }
    switch (url.pathname) {
      case '/api/health':
        return sendJson(res, 200, { status: 'ok', server: config.serverName, uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() });
      case '/api/search':
        return handleSearch(url, res);
      case '/api/weather':
        return handleWeather(url, res);
      default:
        return sendError(res, 404, 'not_found', 'This API route does not exist.');
    }
  }

  async function readFileIfFile(file) {
    try {
      const stat = await fs.promises.stat(file);
      return stat.isFile() ? await fs.promises.readFile(file) : null;
    } catch {
      return null;
    }
  }

  async function serveStatic(res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    if (decoded.includes('\0')) return sendText(res, 400, 'Bad request');

    const relative = decoded === '/' ? '/index.html' : decoded;
    const target = path.join(PUBLIC_DIR, path.normalize(relative));
    if (!target.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 404, 'Page not found');

    // Clean URLs: /privacy serves privacy.html
    const body = (await readFileIfFile(target)) ?? (path.extname(target) ? null : await readFileIfFile(`${target}.html`));
    if (body === null) {
      const notFound = await readFileIfFile(path.join(PUBLIC_DIR, '404.html'));
      if (!notFound) return sendText(res, 404, 'Page not found');
      res.writeHead(404, { 'Content-Type': MIME_TYPES['.html'], 'Content-Length': notFound.length });
      return res.end(notFound);
    }

    const ext = path.extname(target) || '.html';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');

    res.setHeader('X-Served-By', config.serverName);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (config.logRequests) {
      res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    }

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 405, 'method_not_allowed', 'Only GET requests are supported.', { Allow: 'GET, HEAD' });
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, url, res);
      return await serveStatic(res, url.pathname);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'Something went wrong on the server. Try again.');
      else res.end();
    }
  });

  server.on('close', () => limiter.stop());
  return server;
}

if (require.main === module) {
  loadEnvFile(path.join(__dirname, '.env'));
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`ClearDay (${config.serverName}) listening on http://${config.host}:${config.port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, loadConfig, cleanQuery, parseCoordinate };
