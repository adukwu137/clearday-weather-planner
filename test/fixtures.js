'use strict';

const DAYS = ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'];
const HOURS = DAYS.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));

function makeForecast() {
  return {
    latitude: -1.94, longitude: 30.06, elevation: 1567, timezone: 'Africa/Kigali',
    current: {
      time: '2026-11-21T14:15', temperature_2m: 26.2, relative_humidity_2m: 58, apparent_temperature: 27.1,
      is_day: 1, precipitation: 0, weather_code: 2, wind_speed_10m: 12.3,
    },
    hourly: { time: HOURS, temperature_2m: HOURS.map((_, i) => 15 + Math.max(0, 12 - Math.abs((i % 24) - 15))) },
    daily: {
      time: DAYS,
      weather_code: [2, 1, 80, 65, 3, 0, 2],
      temperature_2m_max: [26, 27, 24, 22, 24, 27, 26],
      temperature_2m_min: [15, 15, 16, 16, 15, 14, 15],
      precipitation_sum: [1, 0, 6, 18, 3, 0, 2],
      uv_index_max: [9, 10, 6, 4, 5, 11, 8],
      sunrise: DAYS.map((d) => `${d}T05:58`),
      sunset: DAYS.map((d) => `${d}T18:02`),
    },
  };
}

function makeAir() {
  const targets = [42, 38, 33, 28, 35, 41, 44];
  return {
    current: { time: '2026-11-21T14:00', us_aqi: 42, pm10: 19.4, pm2_5: 11.2 },
    hourly: { time: HOURS, us_aqi: HOURS.map((_, i) => targets[Math.floor(i / 24)] - (i % 5)) },
  };
}

module.exports = { makeForecast, makeAir, DAYS };
