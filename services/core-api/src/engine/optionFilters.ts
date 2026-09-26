import { EMA, ADX, SMA } from 'technicalindicators';
import { OHLCV, TradeAction } from '../types';
import { getLastExitTimestamp } from '../config/redis';

export interface FilterEvaluationResult {
  passed: boolean;
  rejectionReason?: string;
  htf200Ema: number;
  adxValue: number;
  adxRising?: boolean;
  volumeRatio: number;
  htfEmaDistance: number;
}

export class OptionFilters {
  /**
   * Evaluates higher timeframe trend bias, ADX chop/hysteresis filter, volume surge, and anti-whipsaw cooldown.
   */
  public static async evaluateFilters(
    symbol: string,
    action: TradeAction,
    currentPrice: number,
    candles5m: OHLCV[],
    candles15m: OHLCV[]
  ): Promise<FilterEvaluationResult> {
    const result: FilterEvaluationResult = {
      passed: false,
      htf200Ema: currentPrice,
      adxValue: 0,
      adxRising: false,
      volumeRatio: 1.0,
      htfEmaDistance: 0,
    };

    const adxEntryThreshold = parseFloat(process.env.ADX_ENTRY_THRESHOLD || '20.0');
    const requireRisingAdx = process.env.ADX_RISING_REQUIRED === 'true';

    // 1. Higher Timeframe (15m) 200 EMA Trend Bias
    let htf200Ema = currentPrice;
    if (candles15m && candles15m.length >= 200) {
      const htfCloses = candles15m.map((c) => c.close);
      const htfEmaArray = EMA.calculate({ period: 200, values: htfCloses });
      if (htfEmaArray.length > 0) {
        htf200Ema = htfEmaArray[htfEmaArray.length - 1];
      }
    } else if (candles15m && candles15m.length > 0) {
      // Fallback if 200 candles aren't full yet (e.g. initial warmup phase)
      const htfCloses = candles15m.map((c) => c.close);
      const htfEmaArray = EMA.calculate({
        period: Math.min(htfCloses.length, 50),
        values: htfCloses,
      });
      if (htfEmaArray.length > 0) {
        htf200Ema = htfEmaArray[htfEmaArray.length - 1];
      }
    }

    const htfEmaDistance = ((currentPrice - htf200Ema) / htf200Ema) * 100;
    result.htf200Ema = htf200Ema;
    result.htfEmaDistance = htfEmaDistance;

    if (action === 'BUY' && currentPrice < htf200Ema) {
      result.rejectionReason = `HTF_BIAS_BEARISH: Price (${currentPrice}) below 15m 200 EMA (${htf200Ema.toFixed(2)})`;
      return result;
    }

    if (action === 'SELL' && currentPrice > htf200Ema) {
      result.rejectionReason = `HTF_BIAS_BULLISH: Price (${currentPrice}) above 15m 200 EMA (${htf200Ema.toFixed(2)})`;
      return result;
    }

    // 2. Sideways / Chop & Hysteresis Filter: ADX(14) >= adxEntryThreshold (and optional ADX rising check)
    let adxValue = 25; // Default assumption if building candles
    let isAdxRising = true;

    if (candles5m && candles5m.length >= 20) {
      const highs = candles5m.map((c) => c.high);
      const lows = candles5m.map((c) => c.low);
      const closes = candles5m.map((c) => c.close);

      const adxArray = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
      if (adxArray.length >= 2) {
        const latestAdx = adxArray[adxArray.length - 1].adx;
        const prevAdx = adxArray[adxArray.length - 2].adx;
        adxValue = latestAdx;
        isAdxRising = latestAdx >= prevAdx;
      } else if (adxArray.length > 0) {
        adxValue = adxArray[adxArray.length - 1].adx;
      }
    }
    result.adxValue = adxValue;
    result.adxRising = isAdxRising;

    if (adxValue < adxEntryThreshold) {
      result.rejectionReason = `CHOP_FILTER_TRIGGERED: ADX (${adxValue.toFixed(2)}) < threshold ${adxEntryThreshold} (Sideways Market)`;
      return result;
    }

    if (requireRisingAdx && !isAdxRising) {
      result.rejectionReason = `ADX_NOT_RISING: Current ADX (${adxValue.toFixed(2)}) is declining`;
      return result;
    }

    // 3. Volume Surge Check: Signal candle volume >= 1.3x 20-period volume SMA
    let volumeRatio = 1.5;
    if (candles5m && candles5m.length >= 20) {
      const volumes = candles5m.map((c) => c.volume || 1);
      const latestVolume = volumes[volumes.length - 1];
      const volumeSmaArray = SMA.calculate({ period: 20, values: volumes });

      if (volumeSmaArray.length > 0) {
        const volumeSma20 = volumeSmaArray[volumeSmaArray.length - 1];
        volumeRatio = volumeSma20 > 0 ? latestVolume / volumeSma20 : 1.5;
      }
    }
    result.volumeRatio = volumeRatio;

    if (volumeRatio < 1.3) {
      result.rejectionReason = `VOLUME_SURGE_FAILED: Signal volume ratio (${volumeRatio.toFixed(2)}x) < 1.3x 20-SMA`;
      return result;
    }

    // 4. Anti-Whipsaw Cooldown: Minimum 6-bar (30 minutes) lockout period after exit
    const lastExitTimestamp = await getLastExitTimestamp(symbol);
    if (lastExitTimestamp) {
      const thirtyMinutesMs = 30 * 60 * 1000;
      const timeSinceExit = Date.now() - lastExitTimestamp;

      if (timeSinceExit < thirtyMinutesMs) {
        const remainingMinutes = Math.ceil((thirtyMinutesMs - timeSinceExit) / (60 * 1000));
        result.rejectionReason = `WHIPSAW_COOLDOWN_ACTIVE: ${remainingMinutes} mins remaining in 30-min exit lockout`;
        return result;
      }
    }

    result.passed = true;
    return result;
  }
}

