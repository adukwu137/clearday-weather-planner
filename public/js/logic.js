'use strict';

/**
 * Pure UI logic: units, sorting, filtering and saved places.
 * Loaded by the browser as window.ClearDayLogic and by the unit tests as a module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClearDayLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function convertTemp(celsius, units) {
    if (!isNum(celsius)) return null;
    return units === 'imperial' ? (celsius * 9) / 5 + 32 : celsius;
  }

  function formatTemp(celsius, units) {
    const value = convertTemp(celsius, units);
    return value === null ? 'n/a' : `${Math.round(value)}°`;
  }

  function formatWind(kmh, units) {
    if (!isNum(kmh)) return 'n/a';
    return units === 'imperial' ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`;
  }

  function formatMm(mm) {
    return isNum(mm) ? `${Number.isInteger(mm) ? mm : mm.toFixed(1)} mm` : 'n/a';
  }

  /** Returns a new array. Missing values always sort last. */
  function sortDays(days, key) {
    const rules = {
      date: { get: (d) => d.date, dir: 1 },
      tmax: { get: (d) => d.tmax, dir: -1 },
      rain: { get: (d) => d.rain, dir: -1 },
      aqi: { get: (d) => d.aqi, dir: 1 },
      score: { get: (d) => d.score, dir: -1 },
    };
    const rule = rules[key] || rules.date;
    return [...days].sort((a, b) => {
      const x = rule.get(a);
      const y = rule.get(b);
      const xMissing = x === null || x === undefined;
      const yMissing = y === null || y === undefined;
      if (xMissing && yMissing) return a.date.localeCompare(b.date);
      if (xMissing) return 1;
      if (yMissing) return -1;
      if (x === y) return a.date.localeCompare(b.date);
      return (x < y ? -1 : 1) * rule.dir;
    });
  }

  function filterDays(days, filter) {
    switch (filter) {
      case 'dry':
        return days.filter((d) => isNum(d.rain) && d.rain < 1);
      case 'rain':
        return days.filter((d) => isNum(d.rain) && d.rain >= 1);
      case 'goodair':
        return days.filter((d) => isNum(d.aqi) && d.aqi <= 50);
      default:
        return [...days];
    }
  }

  const locationKey = (loc) => `${Number(loc.latitude).toFixed(2)},${Number(loc.longitude).toFixed(2)}`;

  function locationLabel(loc) {
    const parts = [loc.name];
    if (loc.admin1 && loc.admin1 !== loc.name) parts.push(loc.admin1);
    if (loc.country) parts.push(loc.country);
    return parts.join(', ');
  }

  function isValidLocation(loc) {
    return Boolean(loc) && typeof loc.name === 'string' && loc.name.length > 0 && loc.name.length <= 100 &&
      isNum(loc.latitude) && Math.abs(loc.latitude) <= 90 && isNum(loc.longitude) && Math.abs(loc.longitude) <= 180;
  }

  function cleanLocation(loc) {
    return {
      name: loc.name,
      admin1: typeof loc.admin1 === 'string' ? loc.admin1 : null,
      country: typeof loc.country === 'string' ? loc.country : null,
      latitude: loc.latitude,
      longitude: loc.longitude,
    };
  }

  function addRecent(list, loc, max = 6) {
    const key = locationKey(loc);
    return [cleanLocation(loc), ...list.filter((item) => locationKey(item) !== key)].slice(0, max);
  }

  function isFavorite(list, loc) {
    const key = locationKey(loc);
    return list.some((item) => locationKey(item) === key);
  }

  function toggleFavorite(list, loc, max = 12) {
    if (isFavorite(list, loc)) {
      const key = locationKey(loc);
      return { list: list.filter((item) => locationKey(item) !== key), added: false };
    }
    return { list: [cleanLocation(loc), ...list].slice(0, max), added: true };
  }

  function minutesAgo(iso, nowMs) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return 0;
    return Math.max(0, Math.round((nowMs - then) / 60000));
  }

  function describeAge(minutes) {
    if (minutes < 1) return 'less than a minute';
    if (minutes === 1) return '1 minute';
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }

  /** Dates arrive as YYYY-MM-DD in the place's own time zone, so format them in UTC to avoid shifting the day. */
  function weekdayLabel(dateStr, style = 'short') {
    const date = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return dateStr;
    const options = style === 'long'
      ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }
      : { weekday: 'short', day: 'numeric', timeZone: 'UTC' };
    return date.toLocaleDateString('en-GB', options);
  }

  /** Position of an AQI value on the six-band scale, as a percentage from 0 to 100. */
  function aqiScalePercent(aqi) {
    const bands = [0, 50, 100, 150, 200, 300, 500];
    const value = Math.min(Math.max(aqi, 0), 500);
    for (let i = 0; i < bands.length - 1; i += 1) {
      if (value <= bands[i + 1]) {
        const fraction = (value - bands[i]) / (bands[i + 1] - bands[i]);
        return ((i + fraction) / (bands.length - 1)) * 100;
      }
    }
    return 100;
  }

  return {
    convertTemp, formatTemp, formatWind, formatMm, sortDays, filterDays, locationKey, locationLabel,
    isValidLocation, cleanLocation, addRecent, isFavorite, toggleFavorite, minutesAgo, describeAge,
    weekdayLabel, aqiScalePercent,
  };
});
