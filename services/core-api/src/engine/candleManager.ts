import { TickData, OHLCV } from '../types';

export class CandleManager {
  private symbol: string;
  private candles5m: OHLCV[] = [];
  private candles15m: OHLCV[] = [];

  private current5mCandle: Partial<OHLCV> | null = null;
  private current15mCandle: Partial<OHLCV> | null = null;

  private current5mStart: number = 0;
  private current15mStart: number = 0;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  public getSymbol(): string {
    return this.symbol;
  }

  /**
   * Process a live tick and update / close 5m and 15m candles
   */
  public processTick(tick: TickData): { closed5m?: OHLCV; closed15m?: OHLCV } {
    const timestamp = tick.timestamp;
    const price = tick.price;
    const volume = tick.volume || 1;

    const interval5m = 5 * 60 * 1000;
    const interval15m = 15 * 60 * 1000;

    const candle5mStart = Math.floor(timestamp / interval5m) * interval5m;
    const candle15mStart = Math.floor(timestamp / interval15m) * interval15m;

    let closed5m: OHLCV | undefined;
    let closed15m: OHLCV | undefined;

    // 5-minute candle logic
    if (!this.current5mCandle || candle5mStart > this.current5mStart) {
      if (this.current5mCandle && this.current5mCandle.close !== undefined) {
        closed5m = this.current5mCandle as OHLCV;
        this.add5mCandle(closed5m);
      }
      this.current5mStart = candle5mStart;
      this.current5mCandle = {
        timestamp: candle5mStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume,
      };
    } else {
      this.current5mCandle.high = Math.max(this.current5mCandle.high!, price);
      this.current5mCandle.low = Math.min(this.current5mCandle.low!, price);
      this.current5mCandle.close = price;
      this.current5mCandle.volume = (this.current5mCandle.volume || 0) + volume;
    }

    // 15-minute candle logic
    if (!this.current15mCandle || candle15mStart > this.current15mStart) {
      if (this.current15mCandle && this.current15mCandle.close !== undefined) {
        closed15m = this.current15mCandle as OHLCV;
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
      this.current15mCandle.high = Math.max(this.current15mCandle.high!, price);
      this.current15mCandle.low = Math.min(this.current15mCandle.low!, price);
      this.current15mCandle.close = price;
      this.current15mCandle.volume = (this.current15mCandle.volume || 0) + volume;
    }

    return { closed5m, closed15m };
  }

  public add5mCandle(candle: OHLCV): void {
    this.candles5m.push(candle);
    if (this.candles5m.length > 200) {
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
