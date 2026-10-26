/* Year game logic: CSV parsing, the playable filter, scoring and the daily deal.
   No DOM here, so tools can run it in Node (test_game.mjs). Spec: docs/GAME_SPEC.md. */
(function (root) {
  "use strict";

  const BASE_YEAR = 2026;          // age base, fixed to match tools/check_moments.py
  const EPOCH = [2026, 10, 26];    // local date of day #1
  const PER_DAY = 5;
  const MIN_YEAR = -3000, MAX_YEAR = 2026;
  const PLAY_STATUS = new Set(["draft", "reviewed", "scheduled", "played"]);
  const POINTS = [["exact", 100], ["close", 85], ["near", 60], ["rough", 30]];

  // RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes
  function parseCSV(text) {
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = ""; rows.push(row); row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const head = (rows.shift() || []).map(h => h.replace(/^﻿/, "").trim());
    return rows.filter(r => r.some(v => v.trim() !== ""))
      .map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || "").trim()])));
  }

  function isPlayable(r) {
    return PLAY_STATUS.has(r.status) && r.disputed === "n" && r.sensitivity !== "high"
      && !!r.source_1 && !!r.source_2 && !!r.fact && /^-?\d+$/.test(r.year);
  }
  function playable(rows) {
    return rows.filter(isPlayable).map(r => ({ ...r, year: parseInt(r.year, 10), decade: Math.floor(parseInt(r.year, 10) / 10) * 10 }));
  }

  // Python's round(): halves go to the even neighbour
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  function bands(year) {
    const age = BASE_YEAR - year;
    return {
      exact: Math.trunc(age * 0.002),
      close: Math.max(1, pyRound(age * 0.02)),
      near: Math.max(3, pyRound(age * 0.05)),
      rough: Math.max(10, pyRound(age * 0.15)),
    };
  }
  function score(guess, year) {
    if (guess === null || guess === undefined) return { band: "none", points: 0, off: null };
    const off = Math.abs(guess - year), b = bands(year);
    for (const [name, pts] of POINTS) if (off <= b[name]) return { band: name, points: pts, off };
    return { band: "miss", points: 10, off };
  }

  // seeded shuffle, so every player gets the same days
  function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fits(day, m) {
    if (day.some(d => d.year === m.year)) return false;
    return day.filter(d => d.decade === m.decade).length < 2;
  }
  // one pass through the bank: every moment at most once, dealt into valid days
  function dealCycle(bank, cycle) {
    const pool = [...bank].sort((a, b) => a.id < b.id ? -1 : 1), rand = rng(hash("cycle-" + cycle));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const days = [];
    while (pool.length >= PER_DAY) {
      const day = [];
      for (const m of pool) { if (fits(day, m)) day.push(m); if (day.length === PER_DAY) break; }
      if (day.length < PER_DAY) break;
      for (const m of day) pool.splice(pool.indexOf(m), 1);
      days.push(day);
    }
    return days;
  }
  function momentsForDay(bank, dayNo) {
    if (bank.length < PER_DAY || dayNo < 1) return null;
    let n = dayNo - 1, cycle = 0;
    for (;;) {
      const days = dealCycle(bank, cycle);
      if (!days.length) return null;
      if (n < days.length) return days[n];
      n -= days.length; cycle++;
    }
  }

  // calendar days, counted on local dates so DST never shifts a day
  function dayNumber(date) {
    const t = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((t - Date.UTC(EPOCH[0], EPOCH[1] - 1, EPOCH[2])) / 86400000) + 1;
  }
  function dateOfDay(dayNo) { return new Date(EPOCH[0], EPOCH[1] - 1, EPOCH[2] + dayNo - 1); }
  // Monday-to-Sunday week holding dayNo, as seven day numbers
  function weekOf(dayNo) {
    const dow = (dateOfDay(dayNo).getDay() + 6) % 7;
    return Array.from({ length: 7 }, (_, i) => dayNo - dow + i);
  }

  // BC/AD in, signed year out; null + reason when invalid
  function toYear(text, era) {
    const t = String(text).trim();
    if (!/^\d{1,4}$/.test(t)) return { year: null, why: "Type a year." };
    const n = parseInt(t, 10);
    if (n === 0) return { year: null, why: "There is no year 0. Try 1 BC or AD 1." };
    const y = era === "BC" ? -n : n;
    if (y > MAX_YEAR) return { year: null, why: "That is in the future." };
    if (y < MIN_YEAR) return { year: null, why: "Nothing in the game is older than 3000 BC." };
    return { year: y, why: null };
  }
  function label(y) { return y < 0 ? `${-y} BC` : `${y}`; }

  const api = { BASE_YEAR, PER_DAY, MIN_YEAR, MAX_YEAR, parseCSV, isPlayable, playable, pyRound, bands, score,
    dealCycle, momentsForDay, dayNumber, dateOfDay, weekOf, toYear, label };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YearCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
