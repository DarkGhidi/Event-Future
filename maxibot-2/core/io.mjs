import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function loadConfig(path = 'config.json') {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c.mode !== 'paper') throw new Error('V1: seule la simulation est implémentée. Aucun ordre réel.');
  for (const k of ['days', 'trainingDays', 'pollSeconds', 'decisionSeconds', 'virtualCapitalUSDT', 'ticketUSDT', 'maxPositions', 'maxCallsPerDay', 'maxTokensPerDay', 'callTokenReserve', 'maxOutputTokens', 'maxSignalAgeSeconds', 'minClosedForSelection']) {
    if (!Number.isFinite(c[k]) || c[k] <= 0) throw new Error(`Configuration invalide: ${k}`);
  }
  if (c.trainingDays >= c.days || c.ticketUSDT > c.virtualCapitalUSDT) throw new Error('Configuration des phases/capital invalide');
  if (!Array.isArray(c.symbols) || !c.symbols.length || c.symbols.length > 20 || c.symbols.some(s => !/^[A-Z0-9]{2,15}$/.test(s)) || new Set(c.symbols).size !== c.symbols.length) throw new Error('Symboles invalides');
  if (!Array.isArray(c.markets) || !c.markets.length || c.markets.some(m => !['spot', 'futures'].includes(m)) || new Set(c.markets).size !== c.markets.length) throw new Error('Marchés invalides');
  for (const k of ['stopPct', 'takeProfitPct', 'maxDailyLossPct', 'maxDrawdownPct', 'minLeaderWinRate', 'maxLeaderTopCoinShare']) if (!Number.isFinite(c[k]) || c[k] <= 0 || c[k] >= 1) throw new Error(`Configuration invalide: ${k}`);
  for (const k of ['maxSpreadBps', 'slippageBps', 'cooldownMinutes', 'maxHoldMinutes', 'minLeaderClosedTrades']) if (!Number.isFinite(c[k]) || c[k] < 0) throw new Error(`Configuration invalide: ${k}`);
  for (const market of c.markets) if (!Number.isFinite(c.feesBps[market]) || c.feesBps[market] < 0) throw new Error('Frais invalides');
  if (!c.profiles?.length || new Set(c.profiles.map(p => p.name)).size !== c.profiles.length || c.profiles.some(p => !/^[a-z]+$/.test(p.name) || !Number.isFinite(p.minConfidence) || p.minConfidence < 0 || p.minConfidence > 1)) throw new Error('Profils invalides');
  return c;
}
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, time INTEGER, kind TEXT, json TEXT);');
  }
  load() { const r = this.db.prepare('SELECT json FROM state WHERE id=1').get(); return r ? JSON.parse(r.json) : null; }
  save(state, events = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(state));
      const stmt = this.db.prepare('INSERT INTO events(time,kind,json) VALUES(?,?,?)');
      for (const e of events) stmt.run(e.time ?? Date.now(), e.kind, JSON.stringify(e.data));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
export function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Verrou invalide : vérifier le processus avant de supprimer le fichier');
    try { process.kill(pid, 0); throw new Error('Un processus utilise déjà ce portefeuille'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; unlinkSync(path); }
  }
  const fd = openSync(path, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => { if (existsSync(path)) unlinkSync(path); };
}
export async function httpJSON(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const e = new Error(`HTTP_${res.status}`); // Ne jamais journaliser URL privée, en-têtes ou réponse brute.
    e.retryAfter = Number(res.headers.get('retry-after')) || 60;
    throw e;
  }
  return res.json();
}
