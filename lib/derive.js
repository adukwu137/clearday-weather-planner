'use strict';


const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Light snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail',
};

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);

function describeWeatherCode(code) {
  return WEATHER_CODES[code] ?? 'Unknown conditions';
}

function aqiCategory(aqi) {
  const value = finite(aqi);
  if (value === null) return null;
  if (value <= 50) return 'Good';
  if (value <= 100) return 'Moderate';
  if (value <= 150) return 'Unhealthy for sensitive groups';
  if (value <= 200) return 'Unhealthy';
  if (value <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

function outdoorRating({ tmax, rain, uv, aqi }) {
  let score = 100;
  const r = finite(rain);
  const t = finite(tmax);
  const u = finite(uv);
  const a = finite(aqi);

  if (r !== null) {
    if (r >= 15) score -= 65;
    else if (r >= 10) score -= 50;
    else if (r >= 3) score -= 25;
    else if (r >= 1) score -= 8;
  }
  if (t !== null) {
    if (t >= 33) score -= 30;
    else if (t >= 30) score -= 12;
    else if (t <= 10) score -= 25;
    else if (t <= 14) score -= 10;
  }
  if (u !== null) {
    if (u >= 11) score -= 20;
    else if (u >= 8) score -= 8;
  }
  if (a !== null) {
    if (a > 150) score -= 50;
    else if (a > 100) score -= 35;
    else if (a > 50) score -= 12;
  }

  score = Math.max(0, score);
  const label = score >= 88 ? 'Best' : score >= 70 ? 'Good' : score >= 45 ? 'Fair' : 'Poor';
  return { score, label };
}

function aggregateDailyAqi(hourly) {
  const byDate = new Map();
  const times = hourly && Array.isArray(hourly.time) ? hourly.time : [];
  const values = (hourly && hourly.us_aqi) || [];
  times.forEach((time, i) => {
    const value = finite(values[i]);
    if (value === null) return;
    const date = String(time).slice(0, 10);
    if (!byDate.has(date) || value > byDate.get(date)) byDate.set(date, value);
  });
  return byDate;
}


function buildAdvisories(days) {
  const out = [];
  for (const day of days) {
    if (day.rain !== null && day.rain >= 15) out.push({ type: 'rain', date: day.date, value: round1(day.rain) });
    if (day.uv !== null && day.uv >= 11) out.push({ type: 'uv', date: day.date, value: Math.round(day.uv) });
    if (day.tmax !== null && day.tmax >= 33) out.push({ type: 'heat', date: day.date, value: round1(day.tmax) });
    if (day.aqi !== null && day.aqi > 100) out.push({ type: 'air', date: day.date, value: Math.round(day.aqi) });
  }
  return out.slice(0, 6);
}

function buildReport(forecast, air) {
  const daily = forecast.daily;
  const aqiByDate = air ? aggregateDailyAqi(air.hourly) : new Map();

  const days = daily.time.map((date, i) => {
    const tmax = round1(finite(daily.temperature_2m_max?.[i]));
    const tmin = round1(finite(daily.temperature_2m_min?.[i]));
    const rain = round1(finite(daily.precipitation_sum?.[i]));
    const uv = round1(finite(daily.uv_index_max?.[i]));
    const aqi = aqiByDate.has(date) ? aqiByDate.get(date) : null;
    const code = finite(daily.weather_code?.[i]);
    const rating = outdoorRating({ tmax, rain, uv, aqi });
    return { date, weatherCode: code, summary: describeWeatherCode(code), tmax, tmin, rain, uv, aqi, rating: rating.label, score: rating.score };
  });

  const cur = forecast.current;
  const today = String(cur.time).slice(0, 10);
  const todayIndex = Math.max(0, daily.time.indexOf(today));

  const hourly = forecast.hourly.time
    .map((time, i) => ({ time, temp: round1(finite(forecast.hourly.temperature_2m?.[i])) }))
    .filter((h) => h.time.startsWith(today));

  let airSummary = null;
  if (air) {
    const aqi = finite(air.current.us_aqi);
    airSummary = {
      aqi: aqi === null ? null : Math.round(aqi),
      category: aqiCategory(aqi),
      pm25: round1(finite(air.current.pm2_5)),
      pm10: round1(finite(air.current.pm10)),
    };
  }

  return {
    location: {
      latitude: forecast.latitude,
      longitude: forecast.longitude,
      timezone: forecast.timezone ?? null,
      elevation: finite(forecast.elevation),
    },
    current: {
      time: cur.time,
      temperature: round1(finite(cur.temperature_2m)),
      feelsLike: round1(finite(cur.apparent_temperature)),
      humidity: finite(cur.relative_humidity_2m),
      windSpeed: round1(finite(cur.wind_speed_10m)),
      precipitation: round1(finite(cur.precipitation)),
      weatherCode: finite(cur.weather_code),
      summary: describeWeatherCode(cur.weather_code),
      isDay: cur.is_day === 1,
    },
    sun: { sunrise: daily.sunrise?.[todayIndex] ?? null, sunset: daily.sunset?.[todayIndex] ?? null },
    air: airSummary,
    hourly,
    daily: days,
    advisories: buildAdvisories(days),
  };
}

module.exports = { describeWeatherCode, aqiCategory, outdoorRating, aggregateDailyAqi, buildAdvisories, buildReport };
