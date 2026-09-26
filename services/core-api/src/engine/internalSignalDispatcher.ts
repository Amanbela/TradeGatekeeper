import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import moment from 'moment-timezone';
import { OHLCV, FilterChecks, MlFeatureVector } from '../types';
import { RMSService } from '../services/rmsService';
import { getCandleManager } from './candleManager';
import { GainzAlgoEngine } from './gainzAlgoEngine';
import { OptionFilters } from './optionFilters';
import { MlClient } from '../services/mlClient';
import { acquireDailyTradeLock, getTodayISTDateString, isKillSwitchActive } from '../config/redis';
import { SignalModel } from '../models/Signal';
import { PaperTradeModel } from '../models/PaperTrade';
import { TrackerWorker } from '../services/trackerWorker';

export class InternalSignalDispatcher {
  /**
   * Invoked automatically whenever a 5-minute candle closes in CandleManager.
   * Evaluates GainzAlgo indicators, HTF filters, ML win probability, RMS rules,
   * and executes paper trades self-containedly without TradingView webhooks.
   */
  public static async evaluateOnCandleClose(symbol: string, closed5m: OHLCV): Promise<void> {
    const signalId = uuidv4();
    const correlationId = uuidv4();
    const now = new Date();
    const timestampEpoch = closed5m.timestamp || now.getTime();
    const timestampIST = moment(timestampEpoch).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss [IST]');
    const price = closed5m.close;

    const candleMgr = getCandleManager(symbol);
    const candles5m = candleMgr.get5mCandles();
    const candles15m = candleMgr.get15mCandles();

    // 1. Evaluate GainzAlgo V2 Alpha Engine on in-memory 5-minute candles
    const indicatorEval = GainzAlgoEngine.evaluate(candles5m);

    // If GainzAlgo indicator evaluation yielded no signal, exit early (no signal triggered)
    if (indicatorEval.action === 'NONE') {
      return;
    }

    const action = indicatorEval.action;
    const direction = action === 'BUY' ? 'CALL' : 'PUT';
    const strike = `${symbol} ${Math.round(price / 50) * 50} ${direction === 'CALL' ? 'CE' : 'PE'}`;

    // Signal Idempotency Key Generation
    const candleTimestamp = Math.floor(timestampEpoch / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const rawIdempotencyString = `${symbol}:${candleTimestamp}:${direction}:${action}:5m_candle_close`;
    const idempotencyKey = crypto.createHash('sha256').update(rawIdempotencyString).digest('hex');

    // Atomic idempotency check in MongoDB
    const existingSignal = await SignalModel.findOne({ idempotencyKey });
    if (existingSignal) {
      console.warn(`[InternalSignalDispatcher] Duplicate signal skipped! IdempotencyKey: ${idempotencyKey}`);
      return;
    }

    console.log(`[InternalSignalDispatcher] 5M Candle Close Signal Triggered: ${action} (${direction}) ${symbol} @ ${price} [Signal ID: ${signalId} | Correlation: ${correlationId}]`);

    const filterChecks: FilterChecks = {
      htfEmaPass: false,
      adxPass: false,
      volumeSurgePass: false,
      rmsWindowPass: false,
      dailyLimitPass: false,
      staleDataPass: candleMgr.isTickFeedFresh(30000),
      killSwitchPass: !(await isKillSwitchActive()),
      mlPass: false,
    };

    // 2. RMS Check (Momentum Window, Blacklist Dates, Daily Limit, Loss Limits)
    const rmsResult = await RMSService.evaluateRMS(symbol);
    filterChecks.rmsWindowPass = !rmsResult.reason?.includes('OUTSIDE_MOMENTUM_WINDOW');
    filterChecks.dailyLimitPass = !rmsResult.reason?.includes('DAILY_LIMIT_EXCEEDED');

    if (!rmsResult.allowed) {
      console.warn(`[InternalSignalDispatcher] Signal Rejected by RMS: ${rmsResult.reason}`);
      await SignalModel.create({
        signalId,
        correlationId,
        idempotencyKey,
        symbol,
        action,
        direction,
        spotPrice: price,
        timestamp: now,
        timestampIST,
        timestampEpoch,
        selectedStrike: strike,
        candleData: closed5m,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: rmsResult.reason,
        rmsPassed: false,
        indicatorsPassed: true,
        filtersPassed: false,
        mlApproved: false,
        rawPayload: { trigger: '5M_CANDLE_CLOSE', candle: closed5m },
      });
      return;
    }

    // 3. Option Anti-Trap & Anti-Whipsaw Filters Evaluation
    const filterEval = await OptionFilters.evaluateFilters(
      symbol,
      action,
      price,
      candles5m,
      candles15m
    );

    const adxThreshold = parseFloat(process.env.ADX_ENTRY_THRESHOLD || '20.0');
    filterChecks.htfEmaPass = !filterEval.rejectionReason?.includes('HTF_BIAS');
    filterChecks.adxPass = filterEval.adxValue >= adxThreshold;
    filterChecks.volumeSurgePass = filterEval.volumeRatio >= 1.3;

    const indicatorData = {
      ema9: indicatorEval.fastEma,
      ema21: indicatorEval.slowEma,
      rsi14: indicatorEval.rsi,
      adx14: filterEval.adxValue,
      atr14: indicatorEval.atr,
      volumeSma20: filterEval.volumeRatio,
    };

    if (!filterEval.passed) {
      console.warn(`[InternalSignalDispatcher] Signal Rejected by Filters: ${filterEval.rejectionReason}`);
      await SignalModel.create({
        signalId,
        correlationId,
        idempotencyKey,
        symbol,
        action,
        direction,
        spotPrice: price,
        timestamp: now,
        timestampIST,
        timestampEpoch,
        selectedStrike: strike,
        candleData: closed5m,
        indicators: indicatorData,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: filterEval.rejectionReason,
        rmsPassed: true,
        indicatorsPassed: true,
        filtersPassed: false,
        mlApproved: false,
        rawPayload: { trigger: '5M_CANDLE_CLOSE', candle: closed5m },
      });
      return;
    }

    // 4. Construct Feature Vector for Python ML Subsystem
    const atrNormalized = indicatorEval.atr > 0 ? (indicatorEval.atr / price) * 100 : 1.5;
    const oiBuildupScore = 0.5;

    const featureVector: MlFeatureVector = {
      volumeRatio20: filterEval.volumeRatio,
      adxValue: filterEval.adxValue,
      htfEmaDistance: filterEval.htfEmaDistance,
      rsiValue: indicatorEval.rsi,
      atrNormalized,
      oiBuildupScore,
    };

    // 5. Query Python ML Subsystem
    const mlResponse = await MlClient.predict(featureVector);
    filterChecks.mlPass = mlResponse.approved;

    if (!mlResponse.approved) {
      const reason = `ML_DISAPPROVED: Win probability P(Win)=${(mlResponse.probability * 100).toFixed(1)}% is below threshold`;
      console.warn(`[InternalSignalDispatcher] ${reason}`);

      await SignalModel.create({
        signalId,
        correlationId,
        idempotencyKey,
        symbol,
        action,
        direction,
        spotPrice: price,
        timestamp: now,
        timestampIST,
        timestampEpoch,
        selectedStrike: strike,
        candleData: closed5m,
        indicators: indicatorData,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: reason,
        mlScore: mlResponse.probability,
        mlMode: mlResponse.mode,
        rmsPassed: true,
        indicatorsPassed: true,
        filtersPassed: true,
        mlApproved: false,
        mlProbability: mlResponse.probability,
        rawPayload: { trigger: '5M_CANDLE_CLOSE', candle: closed5m },
        features: featureVector,
      });
      return;
    }

    // 6. Acquire Atomic Daily Lock (Strict Capital Protection - 1 Trade per Day)
    const lockAcquired = await acquireDailyTradeLock(symbol);
    if (!lockAcquired && process.env.FORCE_RMS_BYPASS !== 'true') {
      const reason = 'DAILY_LIMIT_EXCEEDED: Another trade acquired atomic lock for today';
      console.warn(`[InternalSignalDispatcher] ${reason}`);
      filterChecks.dailyLimitPass = false;

      await SignalModel.create({
        signalId,
        correlationId,
        idempotencyKey,
        symbol,
        action,
        direction,
        spotPrice: price,
        timestamp: now,
        timestampIST,
        timestampEpoch,
        selectedStrike: strike,
        candleData: closed5m,
        indicators: indicatorData,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: reason,
        mlScore: mlResponse.probability,
        mlMode: mlResponse.mode,
        rmsPassed: false,
        indicatorsPassed: true,
        filtersPassed: true,
        mlApproved: true,
        mlProbability: mlResponse.probability,
        rawPayload: { trigger: '5M_CANDLE_CLOSE', candle: closed5m },
        features: featureVector,
      });
      return;
    }

    // 7. All Checks Passed -> Execute Paper Trade
    const tradeId = `TRADE_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const rawAtr = indicatorEval.atr > 0 ? indicatorEval.atr : 25;
    const effectiveAtr = Math.max(18, Math.min(rawAtr, 35));

    const targetPoints = Math.round(effectiveAtr * 1.5);
    const stopLossPoints = Math.round(effectiveAtr * 1.0);

    let targetPrice: number;
    let stopLossPrice: number;

    if (action === 'BUY') {
      targetPrice = +(price + targetPoints).toFixed(2);
      stopLossPrice = +(price - stopLossPoints).toFixed(2);
    } else {
      targetPrice = +(price - targetPoints).toFixed(2);
      stopLossPrice = +(price + stopLossPoints).toFixed(2);
    }

    console.log(
      `[InternalSignalDispatcher] Dynamic Targets Set: Spot=${price} | ATR=${effectiveAtr.toFixed(1)} | TargetOffset=${targetPoints} pts (TP: ${targetPrice}) | SLOffset=${stopLossPoints} pts (SL: ${stopLossPrice})`
    );

    const tradeDateIST = getTodayISTDateString();
    const token = '26000'; // Nifty 50 Spot Token
    const quantity = parseInt(process.env.NIFTY_LOT_SIZE || '50', 10);
    const slippagePercent = 0.002; // 0.2% slippage on option premium

    const grossEntryPrice = price;
    const netEntryPrice = action === 'BUY' ? grossEntryPrice * (1 + slippagePercent) : grossEntryPrice * (1 - slippagePercent);

    // Save Executed Signal Telemetry to MongoDB
    await SignalModel.create({
      signalId,
      correlationId,
      idempotencyKey,
      symbol,
      action,
      direction,
      spotPrice: price,
      timestamp: now,
      timestampIST,
      timestampEpoch,
      selectedStrike: strike,
      candleData: closed5m,
      indicators: indicatorData,
      filterChecks,
      status: 'EXECUTED',
      rejectionReason: null,
      mlScore: mlResponse.probability,
      mlMode: mlResponse.mode,
      rmsPassed: true,
      indicatorsPassed: true,
      filtersPassed: true,
      mlApproved: true,
      mlProbability: mlResponse.probability,
      rawPayload: { trigger: '5M_CANDLE_CLOSE', candle: closed5m },
      features: featureVector,
    });

    // Create PaperTrade with strict lifecycle state machine
    await PaperTradeModel.create({
      tradeId,
      correlationId,
      idempotencyKey,
      symbol,
      token,
      action,
      direction,
      selectedStrike: strike,
      quantity,
      state: 'POSITION_OPEN',
      status: 'OPEN',
      stateTimestamps: {
        signalDetectedAt: now,
        riskApprovedAt: now,
        orderPlacedAt: now,
        positionOpenedAt: now,
      },
      entryPrice: netEntryPrice,
      grossEntryPrice,
      netEntryPrice,
      targetPrice,
      stopLossPrice,
      entryTimestamp: now,
      exitReason: 'NONE',
      slippagePercent,
      mlProbability: mlResponse.probability,
      mlMode: mlResponse.mode,
      tradeDateIST,
      features: featureVector,
    });

    // Register active paper trade in RAM worker
    TrackerWorker.registerPosition({
      tradeId,
      correlationId,
      idempotencyKey,
      symbol,
      token,
      action,
      entryPrice: netEntryPrice,
      grossEntryPrice,
      targetPrice,
      stopLossPrice,
      entryTimestamp: now.getTime(),
      maxHoldTimeMinutes: 35,
      featureVector,
      quantity,
      selectedStrike: strike,
    });

    console.log(`[InternalSignalDispatcher] SUCCESS: Paper Trade Executed! Trade ID: ${tradeId} | Correlation: ${correlationId} | Strike: ${strike} | Entry: ${netEntryPrice.toFixed(2)}`);
  }
}
