import { EMA, RSI, ATR } from 'technicalindicators';
import { OHLCV, TradeAction } from '../types';

export interface GainzAlgoOutput {
  fastEma: number;
  slowEma: number;
  rsi: number;
  atr: number;
  emaCrossInLast4: boolean;
  rsiTriggered: boolean;
  action: TradeAction | 'NONE';
}

export class GainzAlgoEngine {
  /**
   * Calculates Fast EMA(9), Slow EMA(21), RSI(14), and ATR(14) with 1.5x multiplier.
   * Checks if an EMA crossover/crossunder occurred within the configured max age bars (default 4 bars)
   * AND RSI crosses the 55 (BUY) / 45 (SELL) threshold.
   */
  public static evaluate(candles: OHLCV[]): GainzAlgoOutput {
    const defaultOutput: GainzAlgoOutput = {
      fastEma: 0,
      slowEma: 0,
      rsi: 50,
      atr: 0,
      emaCrossInLast4: false,
      rsiTriggered: false,
      action: 'NONE',
    };

    if (!candles || candles.length < 30) {
      return defaultOutput;
    }

    const maxAgeBars = parseInt(process.env.SIGNAL_MAX_AGE_BARS || '4', 10);

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const fastEmaArray = EMA.calculate({ period: 9, values: closes });
    const slowEmaArray = EMA.calculate({ period: 21, values: closes });
    const rsiArray = RSI.calculate({ period: 14, values: closes });
    const atrArray = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

    if (
      fastEmaArray.length < 5 ||
      slowEmaArray.length < 5 ||
      rsiArray.length < 2 ||
      atrArray.length < 1
    ) {
      return defaultOutput;
    }

    // Align arrays to the latest bar index
    const latestFastEma = fastEmaArray[fastEmaArray.length - 1];
    const latestSlowEma = slowEmaArray[slowEmaArray.length - 1];
    const latestRsi = rsiArray[rsiArray.length - 1];
    const prevRsi = rsiArray[rsiArray.length - 2];
    const latestAtr = atrArray[atrArray.length - 1] * 1.5; // ATR with 1.5 multiplier

    // Check EMA Crossover/Crossunder within maxAgeBars (offset 0 to maxAgeBars - 1)
    let bullishEmaCrossInWindow = false;
    let bearishEmaCrossInWindow = false;

    const fastLen = fastEmaArray.length;
    const slowLen = slowEmaArray.length;

    for (let offset = 0; offset < maxAgeBars; offset++) {
      const idxFastCurr = fastLen - 1 - offset;
      const idxFastPrev = idxFastCurr - 1;
      const idxSlowCurr = slowLen - 1 - offset;
      const idxSlowPrev = idxSlowCurr - 1;

      if (idxFastPrev >= 0 && idxSlowPrev >= 0) {
        const fastCurr = fastEmaArray[idxFastCurr];
        const fastPrev = fastEmaArray[idxFastPrev];
        const slowCurr = slowEmaArray[idxSlowCurr];
        const slowPrev = slowEmaArray[idxSlowPrev];

        if (fastPrev <= slowPrev && fastCurr > slowCurr) {
          bullishEmaCrossInWindow = true;
        }
        if (fastPrev >= slowPrev && fastCurr < slowCurr) {
          bearishEmaCrossInWindow = true;
        }
      }
    }

    // RSI Trigger Condition: RSI crosses 55 (BUY) or 45 (SELL)
    const bullishRsiCross = prevRsi <= 55 && latestRsi > 55;
    const bearishRsiCross = prevRsi >= 45 && latestRsi < 45;

    let action: TradeAction | 'NONE' = 'NONE';
    let emaCrossInLast4 = false;
    let rsiTriggered = false;

    if (bullishEmaCrossInWindow && (bullishRsiCross || latestRsi > 55)) {
      action = 'BUY';
      emaCrossInLast4 = true;
      rsiTriggered = true;
    } else if (bearishEmaCrossInWindow && (bearishRsiCross || latestRsi < 45)) {
      action = 'SELL';
      emaCrossInLast4 = true;
      rsiTriggered = true;
    }

    return {
      fastEma: latestFastEma,
      slowEma: latestSlowEma,
      rsi: latestRsi,
      atr: latestAtr,
      emaCrossInLast4,
      rsiTriggered,
      action,
    };
  }
}

