'use strict';


class UpstreamError extends Error {
  constructor(message, { code = 'upstream_error', status = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
  }
}

const FORECAST_PARAMS = {
  current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m',
  hourly: 'temperature_2m',
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max,sunrise,sunset',
  timezone: 'auto',
  forecast_days: 7,
};

const AIR_PARAMS = {
  current: 'us_aqi,pm10,pm2_5',
  hourly: 'us_aqi',
  timezone: 'auto',
  forecast_days: 7,
};

function createClient({ geocodingUrl, forecastUrl, airQualityUrl, timeoutMs = 8000, fetchImpl = fetch }) {
  async function getJson(baseUrl, params) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    let response;
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'User-Agent': 'ClearDay/1.0 (student project)' },
      });
    } catch (error) {
      const timedOut = error && error.name === 'TimeoutError';
      throw new UpstreamError(timedOut ? 'The weather service timed out.' : 'The weather service could not be reached.', {
        code: timedOut ? 'timeout' : 'network_error',
      });
    }

    if (response.status === 429) {
      throw new UpstreamError('The weather service is rate limiting requests.', { code: 'rate_limited', status: 429 });
    }
    if (!response.ok) {
      throw new UpstreamError(`The weather service answered with status ${response.status}.`, {
        code: 'bad_status',
        status: response.status,
      });
    }

    try {
      return await response.json();
    } catch {
      throw new UpstreamError('The weather service returned invalid JSON.', { code: 'bad_response' });
    }
  }

  const unexpected = () => new UpstreamError('The weather service returned data in an unexpected format.', { code: 'bad_response' });

  async function searchCities(query) {
    const data = await getJson(geocodingUrl, { name: query, count: 6, language: 'en', format: 'json' });
    if (!data || typeof data !== 'object') throw unexpected();
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && typeof r.name === 'string')
      .map((r) => ({
        id: r.id ?? null,
        name: r.name,
        admin1: r.admin1 ?? null,
        country: r.country ?? null,
        countryCode: r.country_code ?? null,
        latitude: r.latitude,
        longitude: r.longitude,
        timezone: r.timezone ?? null,
      }));
  }

  async function getForecast(latitude, longitude) {
    const data = await getJson(forecastUrl, { latitude, longitude, ...FORECAST_PARAMS });
    const valid =
      data && data.current && data.daily && Array.isArray(data.daily.time) && data.hourly && Array.isArray(data.hourly.time);
    if (!valid) throw unexpected();
    return data;
  }

  async function getAirQuality(latitude, longitude) {
    const data = await getJson(airQualityUrl, { latitude, longitude, ...AIR_PARAMS });
    const valid = data && data.current && data.hourly && Array.isArray(data.hourly.time);
    if (!valid) throw unexpected();
    return data;
  }

  return { searchCities, getForecast, getAirQuality };
}

module.exports = { createClient, UpstreamError };
