import { createHmac } from 'node:crypto';
import { httpJSON, sleep } from './io.mjs';
const BASE = 'https://api.mexc.com';
const num = v => { if (v === null || v === undefined || v === '') throw new Error('Champ marché absent'); const n = Number(v); if (!Number.isFinite(n)) throw new Error('Champ marché invalide'); return n; };
export class Mexc {
  constructor(request = httpJSON) { this.request = request; this.blockedUntil = 0; }
  async get(path, params = {}) {
    if (Date.now() < this.blockedUntil) throw new Error('MEXC_COOLDOWN');
    await sleep(120); // Requêtes publiques séquentielles, pas de rafale.
    try {
      const r = await this.request(`${BASE}${path}?${new URLSearchParams(params)}`);
      if (r.success === false || (r.code !== undefined && r.code !== 0)) throw new Error('MEXC_API_ERROR');
      return r.data ?? r;
    } catch (e) { if (/HTTP_(418|429)/.test(e.message)) this.blockedUntil = Date.now() + e.retryAfter * 1000; throw e; }
  }
  async snapshot(asset, market, now = Date.now()) {
    const symbol = market === 'spot' ? `${asset}USDT` : `${asset}_USDT`;
    let candles, q, fundingHistory = [], funding = null;
    if (market === 'spot') {
      q = await this.get('/api/v3/ticker/bookTicker', { symbol });
      const rows = await this.get('/api/v3/klines', { symbol, interval: '1m', limit: 120 });
      if (!Array.isArray(rows)) throw new Error('Bougies spot invalides');
      candles = rows.map(r => ({ t: num(r[0]), closeTime: num(r[6]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]) })).filter(r => r.closeTime < now);
    } else {
      q = await this.get('/api/v1/contract/ticker', { symbol });
      if (Array.isArray(q)) q = q.find(r => r.symbol === symbol);
      const d = await this.get(`/api/v1/contract/kline/${symbol}`, { interval: 'Min1', start: Math.floor(now / 1000) - 7200, end: Math.floor(now / 1000) });
      candles = d.time.map((t, i) => ({ t: num(t) * 1000, closeTime: num(t) * 1000 + 60000, open: num(d.open[i]), high: num(d.high[i]), low: num(d.low[i]), close: num(d.close[i]), volume: num(d.vol[i]) })).filter(r => r.closeTime < now);
      funding = await this.get(`/api/v1/contract/funding_rate/${symbol}`);
      const h = await this.get('/api/v1/contract/funding_rate/history', { symbol, page_num: 1, page_size: 100 });
      if (!Array.isArray(h.resultList) || !h.resultList.length) throw new Error('Historique funding absent');
      fundingHistory = h.resultList.map(r => ({ time: num(r.settleTime), rate: num(r.fundingRate) })).sort((a, b) => a.time - b.time);
    }
    candles.sort((a,b) => a.t - b.t);
    if (candles.length < 60 || candles.some(r => [r.open,r.high,r.low,r.close].some(n => n <= 0) || r.low > r.high || r.volume < 0)) throw new Error('Bougies insuffisantes/invalides');
    for (let i = 1; i < candles.length; i++) if (candles[i].t - candles[i-1].t !== 60000) throw new Error('Trou dans les bougies');
    if (now - candles.at(-1).closeTime > 120000) throw new Error('Bougies périmées');
    const bid = num(market === 'spot' ? q.bidPrice : q.bid1), ask = num(market === 'spot' ? q.askPrice : q.ask1);
    if (bid <= 0 || ask < bid) throw new Error('Cotations invalides');
    const observedAt = Date.now();
    const quoteTime = market === 'futures' ? num(q.timestamp) : observedAt;
    if (Math.abs(observedAt - quoteTime) > 120000) throw new Error('Cotation périmée');
    const closes = candles.map(r => r.close), mean = a => a.reduce((s,v) => s+v,0) / a.length;
    const returns = closes.slice(1).map((v,i) => v / closes[i] - 1);
    return { id: `${market}:${asset}`, market, asset, symbol, bid, ask, observedAt, quoteTime,
      spreadBps: (ask - bid) / ((bid + ask)/2) * 10000, candles, fundingHistory,
      fundingRate: funding ? num(funding.fundingRate) : null,
      nextFundingTime: funding ? num(funding.nextSettleTime) : null,
      features: { lastClosedPrice: closes.at(-1), return5m: closes.at(-1)/closes.at(-6)-1, return30m: closes.at(-1)/closes.at(-31)-1,
        sma20: mean(closes.slice(-20)), sma60: mean(closes.slice(-60)), volatility60: Math.sqrt(mean(returns.slice(-60).map(v => v*v))),
        volumeRatio: mean(candles.slice(-5).map(r => r.volume)) / (mean(candles.slice(-60).map(r => r.volume)) || 1) } };
  }
  async accountCheck(credentials = {}) {
    const key = credentials.spotKey ?? process.env.MEXC_API_KEY, secret = credentials.spotSecret ?? process.env.MEXC_API_SECRET;
    if (!key || !secret) throw new Error('Clés MEXC Spot absentes');
    const time = await this.get('/api/v3/time');
    const qs = new URLSearchParams({ timestamp: String(time.serverTime), recvWindow: '5000' }).toString();
    const signature = createHmac('sha256', secret).update(qs).digest('hex');
    const r = await this.request(`${BASE}/api/v3/account?${qs}&signature=${signature}`, { headers: { 'X-MEXC-APIKEY': key } });
    const result = { spotRead: true, spotCanTrade: r.canTrade === true, withdrawalPermission: r.canWithdraw === true };
    const fk = credentials.futuresKey ?? process.env.MEXC_FUTURES_API_KEY, fs = credentials.futuresSecret ?? process.env.MEXC_FUTURES_API_SECRET;
    if (fk && fs) {
      const timestamp = String(Date.now());
      const signature = createHmac('sha256', fs).update(fk + timestamp).digest('hex');
      const f = await this.request(`${BASE}/api/v1/private/account/assets`, { headers: { ApiKey: fk, 'Request-Time': timestamp, Signature: signature } });
      if (f.success !== true) throw new Error('Lecture compte Futures refusée');
      result.futuresRead = true; // Lecture ne prouve PAS les droits d'envoi d'ordres.
    } else result.futuresRead = 'not_configured';
    return result;
  }
}
