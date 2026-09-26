import moment from 'moment-timezone';
import { TickData, OHLCV } from '../types';
import { InternalSignalDispatcher } from './internalSignalDispatcher';

export class CandleManager {
  private symbol: string;
  private candles5m: OHLCV[] = [];
  private candles15m: OHLCV[] = [];

  private current5mCandle: (OHLCV & { isIncomplete?: boolean }) | null = null;
  private current15mCandle: (OHLCV & { isIncomplete?: boolean }) | null = null;

  private current5mStart: number = 0;
  private current15mStart: number = 0;

  private lastFinalized5mStart: number = 0;
  private lastTickTimestamp: number = 0;

  // Duplicate tick deduplication sliding cache (stores tick hash -> timestamp)
  private tickDeduplicationSet: Map<string, number> = new Map();

  // Feed status & late tick counters
  private isFeedDegraded: boolean = false;
  private lateTicksCount: number = 0;
  private isConnectionInterrupted: boolean = false;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  public getSymbol(): string {
    return this.symbol;
  }

  public getLastTickTimestamp(): number {
    return this.lastTickTimestamp;
  }

  public setConnectionInterrupted(interrupted: boolean): void {
    this.isConnectionInterrupted = interrupted;
    if (interrupted && this.current5mCandle) {
      this.current5mCandle.isIncomplete = true;
      console.warn(`[CandleManager] Connection interrupted. Marked current 5M candle (${this.current5mStart}) as INCOMPLETE.`);
    }
  }

  /**
   * Health Evaluator: Check if tick feed is fresh (received tick within last thresholdMs, default 30s)
   */
  public isTickFeedFresh(thresholdMs = 30000): boolean {
    if (this.lastTickTimestamp === 0) {
      return true;
    }
    const elapsed = Date.now() - this.lastTickTimestamp;
    return elapsed <= thresholdMs;
  }

  /**
   * Helper method to process ticks using token and price directly
   */
  public onTickReceived(token: string, price: number, volume: number = 1): { closed5m?: OHLCV; closed15m?: OHLCV } {
    const symbol = token === '26000' ? 'NIFTY' : token;
    return this.processTick({
      symbol,
      token,
      price,
      volume,
      timestamp: Date.now(),
    });
  }

  /**
   * Static helper to load historical 5M candles into a symbol's CandleManager
   */
  public static loadHistoricalCandles(symbol: string, candles5m: OHLCV[]): void {
    getCandleManager(symbol).loadHistoricalCandles(candles5m);
  }

  /**
   * Inject historical 5-minute candles and derive/pre-populate 15-minute candles automatically
   */
  public loadHistoricalCandles(candles5m: OHLCV[]): void {
    this.candles5m = [...candles5m].sort((a, b) => a.timestamp - b.timestamp);

    const interval15m = 15 * 60 * 1000;
    const map15m = new Map<number, OHLCV>();

    for (const c of this.candles5m) {
      const start15m = Math.floor(c.timestamp / interval15m) * interval15m;
      if (!map15m.has(start15m)) {
        map15m.set(start15m, {
          timestamp: start15m,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume || 0,
        });
      } else {
        const existing = map15m.get(start15m)!;
        existing.high = Math.max(existing.high, c.high);
        existing.low = Math.min(existing.low, c.low);
        existing.close = c.close;
        existing.volume += c.volume || 0;
      }
    }

    this.candles15m = Array.from(map15m.values()).sort((a, b) => a.timestamp - b.timestamp);

    if (this.candles5m.length > 0) {
      const last5m = this.candles5m[this.candles5m.length - 1];
      this.current5mStart = Math.floor(last5m.timestamp / (5 * 60 * 1000)) * (5 * 60 * 1000);
      this.lastFinalized5mStart = this.current5mStart;
    }
    if (this.candles15m.length > 0) {
      const last15m = this.candles15m[this.candles15m.length - 1];
      this.current15mStart = Math.floor(last15m.timestamp / (15 * 60 * 1000)) * (15 * 60 * 1000);
    }

    console.log(`[CandleManager] Injected ${this.candles5m.length} 5M candles & derived ${this.candles15m.length} 15M candles for ${this.symbol}.`);
  }

  /**
   * Process a live tick, update in-memory candle state, detect candle close,
   * with duplicate tick filtering and out-of-order tick handling.
   */
  public processTick(tick: TickData): { closed5m?: OHLCV; closed15m?: OHLCV } {
    const timestamp = tick.timestamp || Date.now();

    // 1. Duplicate Tick Protection
    const tickHash = `${tick.token}:${timestamp}:${tick.price}:${tick.volume}`;
    if (this.tickDeduplicationSet.has(tickHash)) {
      // Duplicate tick detected! Ignore to prevent corrupting candle volume/OHLC.
      return {};
    }

    this.tickDeduplicationSet.set(tickHash, Date.now());
    // Prune deduplication cache if > 1000 entries
    if (this.tickDeduplicationSet.size > 1000) {
      const oldestKey = this.tickDeduplicationSet.keys().next().value;
      if (oldestKey) this.tickDeduplicationSet.delete(oldestKey);
    }

    this.lastTickTimestamp = timestamp;
    const price = tick.price;
    const volume = tick.volume || 1;

    const interval5m = 5 * 60 * 1000;
    const interval15m = 15 * 60 * 1000;

    const candle5mStart = Math.floor(timestamp / interval5m) * interval5m;
    const candle15mStart = Math.floor(timestamp / interval15m) * interval15m;

    // 2. Out-of-Order / Delayed Tick Protection
    if (this.lastFinalized5mStart > 0 && candle5mStart < this.lastFinalized5mStart) {
      this.lateTicksCount++;
      console.warn(
        `[CandleManager] Delayed/Out-of-order tick received for ${this.symbol} (Tick time: ${new Date(timestamp).toISOString()}, Finalized boundary: ${new Date(this.lastFinalized5mStart).toISOString()}). Ignored to preserve finalized candle integrity.`
      );
      return {};
    }

    let closed5m: OHLCV | undefined;
    let closed15m: OHLCV | undefined;

    // 5-minute candle logic
    if (!this.current5mCandle || candle5mStart > this.current5mStart) {
      if (this.current5mCandle && this.current5mCandle.close !== undefined) {
        closed5m = {
          timestamp: this.current5mCandle.timestamp,
          open: this.current5mCandle.open,
          high: this.current5mCandle.high,
          low: this.current5mCandle.low,
          close: this.current5mCandle.close,
          volume: this.current5mCandle.volume,
        };
        const isIncomplete = this.current5mCandle.isIncomplete || this.isConnectionInterrupted;

        this.add5mCandle(closed5m);
        this.lastFinalized5mStart = this.current5mStart;

        const timeIST = moment(closed5m.timestamp).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss [IST]');
        console.log(
          `[CandleManager] 5M Candle Closed for ${this.symbol} (${isIncomplete ? 'PARTIAL/INCOMPLETE' : 'FULL'}): O=${closed5m.open} H=${closed5m.high} L=${closed5m.low} C=${closed5m.close} V=${closed5m.volume} at ${timeIST}`
        );

        // 3. Partial Candle Protection: Suppress automatic signal generation if candle is incomplete!
        if (!isIncomplete) {
          InternalSignalDispatcher.evaluateOnCandleClose(this.symbol, closed5m).catch((err) => {
            console.error(`[CandleManager] Error evaluating signal on 5M candle close for ${this.symbol}:`, err);
          });
        } else {
          console.warn(`[CandleManager] Suppressed signal evaluation for ${this.symbol} on incomplete/partial candle.`);
        }
      }
      this.current5mStart = candle5mStart;
      this.current5mCandle = {
        timestamp: candle5mStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume,
        isIncomplete: this.isConnectionInterrupted,
      };
      this.isConnectionInterrupted = false; // Reset connection interrupt flag for new candle
    } else {
      this.current5mCandle.high = Math.max(this.current5mCandle.high, price);
      this.current5mCandle.low = Math.min(this.current5mCandle.low, price);
      this.current5mCandle.close = price;
      this.current5mCandle.volume = (this.current5mCandle.volume || 0) + volume;
    }

    // 15-minute candle logic
    if (!this.current15mCandle || candle15mStart > this.current15mStart) {
      if (this.current15mCandle && this.current15mCandle.close !== undefined) {
        closed15m = {
          timestamp: this.current15mCandle.timestamp,
          open: this.current15mCandle.open,
          high: this.current15mCandle.high,
          low: this.current15mCandle.low,
          close: this.current15mCandle.close,
          volume: this.current15mCandle.volume,
        };
        this.add15mCandle(closed15m);
      }
      this.current15mStart = candle15mStart;
      this.current15mCandle = {
        timestamp: candle15mStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume,
      };
    } else {
      this.current15mCandle.high = Math.max(this.current15mCandle.high, price);
      this.current15mCandle.low = Math.min(this.current15mCandle.low, price);
      this.current15mCandle.close = price;
      this.current15mCandle.volume = (this.current15mCandle.volume || 0) + volume;
    }

    return { closed5m, closed15m };
  }

  public add5mCandle(candle: OHLCV): void {
    this.candles5m.push(candle);
    if (this.candles5m.length > 300) {
      this.candles5m.shift();
    }
  }

  public add15mCandle(candle: OHLCV): void {
    this.candles15m.push(candle);
    if (this.candles15m.length > 300) {
      this.candles15m.shift();
    }
  }

  public get5mCandles(): OHLCV[] {
    return [...this.candles5m];
  }

  public get15mCandles(): OHLCV[] {
    return [...this.candles15m];
  }

  /**
   * Seed historical OHLCV data directly (e.g. for startup / backtest)
   */
  public seedCandles(c5m: OHLCV[], c15m: OHLCV[]): void {
    this.candles5m = [...c5m];
    this.candles15m = [...c15m];
  }
}

// Global registry of candle managers per symbol
const candleManagers: Map<string, CandleManager> = new Map();

export function getCandleManager(symbol: string): CandleManager {
  if (!candleManagers.has(symbol)) {
    candleManagers.set(symbol, new CandleManager(symbol));
  }
  return candleManagers.get(symbol)!;
}

