'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeWeatherCode, aqiCategory, outdoorRating, aggregateDailyAqi, buildAdvisories, buildReport } = require('../lib/derive');
const { makeForecast, makeAir } = require('./fixtures');

test('describeWeatherCode maps WMO codes and handles unknown codes', () => {
  assert.equal(describeWeatherCode(0), 'Clear sky');
  assert.equal(describeWeatherCode(65), 'Heavy rain');
  assert.equal(describeWeatherCode(1234), 'Unknown conditions');
  assert.equal(describeWeatherCode(null), 'Unknown conditions');
});

test('aqiCategory uses the US AQI bands', () => {
  assert.equal(aqiCategory(0), 'Good');
  assert.equal(aqiCategory(50), 'Good');
  assert.equal(aqiCategory(51), 'Moderate');
  assert.equal(aqiCategory(101), 'Unhealthy for sensitive groups');
  assert.equal(aqiCategory(151), 'Unhealthy');
  assert.equal(aqiCategory(250), 'Very unhealthy');
  assert.equal(aqiCategory(301), 'Hazardous');
  assert.equal(aqiCategory(null), null);
  assert.equal(aqiCategory(NaN), null);
});

test('outdoorRating rewards calm dry days and penalises bad ones', () => {
  assert.deepEqual(outdoorRating({ tmax: 24, rain: 0, uv: 5, aqi: 30 }), { score: 100, label: 'Best' });
  assert.equal(outdoorRating({ tmax: 26, rain: 1, uv: 9, aqi: 42 }).label, 'Good');
  assert.equal(outdoorRating({ tmax: 22, rain: 18, uv: 4, aqi: 28 }).label, 'Poor');
  assert.equal(outdoorRating({ tmax: 36, rain: 0, uv: 11, aqi: 160 }).label, 'Poor');
  assert.equal(outdoorRating({ tmax: 24, rain: 4, uv: 5, aqi: 60 }).label, 'Fair');
});

test('outdoorRating ignores missing values instead of treating them as zero', () => {
  assert.equal(outdoorRating({ tmax: null, rain: null, uv: null, aqi: null }).score, 100);
  assert.equal(outdoorRating({ tmax: null, rain: 0, uv: 5, aqi: null }).label, 'Best');
  assert.ok(outdoorRating({ tmax: 5, rain: 0, uv: 1, aqi: 10 }).score < 100);
});

test('aggregateDailyAqi keeps the daily maximum and skips nulls', () => {
  const map = aggregateDailyAqi({
    time: ['2026-11-21T00:00', '2026-11-21T01:00', '2026-11-22T00:00', '2026-11-22T01:00'],
    us_aqi: [30, 55, null, null],
  });
  assert.equal(map.get('2026-11-21'), 55);
  assert.equal(map.has('2026-11-22'), false);
  assert.equal(aggregateDailyAqi(undefined).size, 0);
});

test('buildAdvisories flags heavy rain, UV, heat and air quality and caps the list', () => {
  const day = (date, o) => ({ date, rain: 0, uv: 0, tmax: 25, aqi: 30, ...o });
  const list = buildAdvisories([
    day('d1', { rain: 20 }), day('d2', { uv: 11 }), day('d3', { tmax: 35 }), day('d4', { aqi: 120 }),
    day('d5', { rain: 15.5 }), day('d6', { uv: 8 }), day('d7', { rain: 30 }),
  ]);
  assert.deepEqual(list.slice(0, 4).map((a) => a.type), ['rain', 'uv', 'heat', 'air']);
  assert.equal(list.length, 6);
  assert.deepEqual(buildAdvisories([day('d1', { rain: null, uv: null, tmax: null, aqi: null })]), []);
});

test('buildReport combines weather and air quality', () => {
  const report = buildReport(makeForecast(), makeAir());
  assert.equal(report.current.temperature, 26.2);
  assert.equal(report.current.summary, 'Partly cloudy');
  assert.equal(report.current.isDay, true);
  assert.deepEqual(report.sun, { sunrise: '2026-11-21T05:58', sunset: '2026-11-21T18:02' });
  assert.deepEqual(report.air, { aqi: 42, category: 'Good', pm25: 11.2, pm10: 19.4 });
  assert.equal(report.daily.length, 7);
  assert.equal(report.hourly.length, 24);
  assert.ok(report.hourly.every((h) => h.time.startsWith('2026-11-21')));
  assert.deepEqual(report.daily.map((d) => d.aqi), [42, 38, 33, 28, 35, 41, 44]);
  assert.equal(report.daily[3].rating, 'Poor');
  assert.equal(report.daily[1].rating, 'Best');
  assert.ok(report.advisories.some((a) => a.type === 'rain' && a.date === '2026-11-24' && a.value === 18));
});

test('buildReport still works when air quality is unavailable', () => {
  const report = buildReport(makeForecast(), null);
  assert.equal(report.air, null);
  assert.ok(report.daily.every((d) => d.aqi === null));
  assert.equal(report.daily.length, 7);
});

test('buildReport tolerates null readings from the API', () => {
  const forecast = makeForecast();
  forecast.current.apparent_temperature = null;
  forecast.daily.uv_index_max[0] = null;
  const report = buildReport(forecast, makeAir());
  assert.equal(report.current.feelsLike, null);
  assert.equal(report.daily[0].uv, null);
});