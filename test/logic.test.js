'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/js/logic');

const days = [
  { date: '2026-11-21', tmax: 26, rain: 1, aqi: 42, score: 84 },
  { date: '2026-11-22', tmax: 27, rain: 0, aqi: 38, score: 92 },
  { date: '2026-11-23', tmax: 24, rain: 6, aqi: null, score: 60 },
  { date: '2026-11-24', tmax: 22, rain: 18, aqi: 55, score: 35 },
];

test('temperature and wind formatting follow the chosen units', () => {
  assert.equal(L.formatTemp(26.4, 'metric'), '26°');
  assert.equal(L.formatTemp(0, 'imperial'), '32°');
  assert.equal(L.formatTemp(null, 'metric'), 'n/a');
  assert.equal(L.formatWind(10, 'metric'), '10 km/h');
  assert.equal(L.formatWind(10, 'imperial'), '6 mph');
  assert.equal(L.formatMm(3), '3 mm');
  assert.equal(L.formatMm(2.6), '2.6 mm');
  assert.equal(L.formatMm(null), 'n/a');
});

test('sortDays sorts without mutating and puts missing values last', () => {
  const copy = JSON.stringify(days);
  assert.deepEqual(L.sortDays(days, 'tmax').map((d) => d.tmax), [27, 26, 24, 22]);
  assert.deepEqual(L.sortDays(days, 'rain').map((d) => d.rain), [18, 6, 1, 0]);
  assert.deepEqual(L.sortDays(days, 'aqi').map((d) => d.aqi), [38, 42, 55, null]);
  assert.deepEqual(L.sortDays(days, 'score').map((d) => d.score), [92, 84, 60, 35]);
  assert.deepEqual(L.sortDays([...days].reverse(), 'date').map((d) => d.date), days.map((d) => d.date));
  assert.equal(JSON.stringify(days), copy);
  assert.deepEqual(L.sortDays(days, 'unknown').map((d) => d.date), days.map((d) => d.date));
});

test('filterDays supports dry, rain and good air', () => {
  assert.deepEqual(L.filterDays(days, 'dry').map((d) => d.date), ['2026-11-22']);
  assert.deepEqual(L.filterDays(days, 'rain').map((d) => d.date), ['2026-11-21', '2026-11-23', '2026-11-24']);
  assert.deepEqual(L.filterDays(days, 'goodair').map((d) => d.date), ['2026-11-21', '2026-11-22']);
  assert.equal(L.filterDays(days, 'all').length, 4);
});

const kigali = { name: 'Kigali', admin1: 'Kigali', country: 'Rwanda', latitude: -1.94, longitude: 30.06 };
const nairobi = { name: 'Nairobi', admin1: 'Nairobi County', country: 'Kenya', latitude: -1.28, longitude: 36.82 };

test('location labels avoid repeating the city name', () => {
  assert.equal(L.locationLabel(kigali), 'Kigali, Rwanda');
  assert.equal(L.locationLabel(nairobi), 'Nairobi, Nairobi County, Kenya');
});

test('isValidLocation rejects bad stored data', () => {
  assert.equal(L.isValidLocation(kigali), true);
  assert.equal(L.isValidLocation(null), false);
  assert.equal(L.isValidLocation({ name: '', latitude: 1, longitude: 1 }), false);
  assert.equal(L.isValidLocation({ name: 'X', latitude: 91, longitude: 1 }), false);
  assert.equal(L.isValidLocation({ name: 'X', latitude: '1', longitude: 1 }), false);
});

test('addRecent moves repeats to the front and caps the list', () => {
  let list = [];
  list = L.addRecent(list, kigali);
  list = L.addRecent(list, nairobi);
  list = L.addRecent(list, kigali);
  assert.deepEqual(list.map((l) => l.name), ['Kigali', 'Nairobi']);
  for (let i = 0; i < 10; i += 1) list = L.addRecent(list, { name: `C${i}`, latitude: i, longitude: i }, 6);
  assert.equal(list.length, 6);
});

test('toggleFavorite adds and removes', () => {
  const added = L.toggleFavorite([], kigali);
  assert.equal(added.added, true);
  assert.equal(L.isFavorite(added.list, kigali), true);
  const removed = L.toggleFavorite(added.list, kigali);
  assert.equal(removed.added, false);
  assert.deepEqual(removed.list, []);
});

test('time helpers', () => {
  const now = Date.parse('2026-11-21T12:30:00Z');
  assert.equal(L.minutesAgo('2026-11-21T12:18:00Z', now), 12);
  assert.equal(L.minutesAgo('2026-11-21T13:00:00Z', now), 0);
  assert.equal(L.minutesAgo('nonsense', now), 0);
  assert.equal(L.describeAge(0), 'less than a minute');
  assert.equal(L.describeAge(12), '12 minutes');
  assert.equal(L.describeAge(125), '2 hours');
});

test('weekdayLabel keeps the calendar day regardless of time zone', () => {
  assert.match(L.weekdayLabel('2026-11-21'), /^Sat,? 21$/);
  assert.match(L.weekdayLabel('2026-11-21', 'long'), /^Saturday,? 21 November$/);
  assert.equal(L.weekdayLabel('not a date'), 'not a date');
});

test('aqiScalePercent places values on the six-band scale', () => {
  assert.equal(L.aqiScalePercent(0), 0);
  assert.ok(Math.abs(L.aqiScalePercent(25) - 8.333) < 0.01);
  assert.ok(Math.abs(L.aqiScalePercent(50) - 16.667) < 0.01);
  assert.equal(L.aqiScalePercent(500), 100);
  assert.equal(L.aqiScalePercent(900), 100);
  assert.equal(L.aqiScalePercent(-5), 0);
});
