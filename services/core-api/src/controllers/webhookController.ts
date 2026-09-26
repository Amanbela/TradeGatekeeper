import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import moment from 'moment-timezone';
import { SignalPayload, MlFeatureVector, FilterChecks, OHLCV } from '../types';
import { RMSService } from '../services/rmsService';
import { getCandleManager } from '../engine/candleManager';
import { GainzAlgoEngine } from '../engine/gainzAlgoEngine';
import { OptionFilters } from '../engine/optionFilters';
import { MlClient } from '../services/mlClient';
import { acquireDailyTradeLock, getTodayISTDateString, isKillSwitchActive } from '../config/redis';
import { SignalModel } from '../models/Signal';
import { PaperTradeModel } from '../models/PaperTrade';
import { TrackerWorker } from '../services/trackerWorker';

export class WebhookController {
  public static async handleSignal(req: Request, res: Response): Promise<void> {
    const payload: SignalPayload = req.body;
    const symbol = payload.symbol || 'NIFTY';
    const action = payload.action;
    const price = payload.price;

    if (!action || !price || !['BUY', 'SELL'].includes(action)) {
      res.status(400).json({ error: 'INVALID_PAYLOAD', message: 'Action (BUY/SELL) and price required.' });
      return;
    }

    const signalId = uuidv4();
    const correlationId = payload.correlationId || uuidv4();
    const now = new Date();
    const timestampEpoch = payload.timestamp || now.getTime();
    const timestampIST = moment(now).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss [IST]');
    const direction = action === 'BUY' ? 'CALL' : 'PUT';
    const strike = payload.selectedStrike || `${symbol} ${Math.round(price / 50) * 50} ${direction === 'CALL' ? 'CE' : 'PE'}`;

    // Signal Idempotency Key Generation
    const candleTimestamp = Math.floor(timestampEpoch / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const rawIdempotencyString = `${symbol}:${candleTimestamp}:${direction}:${action}:${payload.timeframe || '5m'}`;
    const idempotencyKey = payload.idempotencyKey || crypto.createHash('sha256').update(rawIdempotencyString).digest('hex');

    // 0. Check Signal Idempotency in MongoDB
    const existingSignal = await SignalModel.findOne({ idempotencyKey });
    if (existingSignal) {
      console.warn(`[Webhook] Duplicate signal detected! IdempotencyKey: ${idempotencyKey}. Signal ID: ${existingSignal.signalId}`);
      res.status(409).json({
        status: 'REJECTED',
        reason: 'DUPLICATE_SIGNAL',
        message: 'Signal already processed for this candle and direction.',
        existingSignalId: existingSignal.signalId,
        idempotencyKey,
      });
      return;
    }

    console.log(`[Webhook] Ingesting Signal [${signalId}] (Correlation: ${correlationId}): ${action} (${direction}) ${symbol} @ ${price}`);

    const candleMgr = getCandleManager(symbol);
    const candles5m = candleMgr.get5mCandles();
    const candles15m = candleMgr.get15mCandles();
    const latestCandle: OHLCV | undefined = candles5m.length > 0 ? candles5m[candles5m.length - 1] : undefined;

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

    // 1. RMS Check
    const rmsResult = await RMSService.evaluateRMS(symbol);
    filterChecks.rmsWindowPass = !rmsResult.reason?.includes('OUTSIDE_MOMENTUM_WINDOW');
    filterChecks.dailyLimitPass = !rmsResult.reason?.includes('DAILY_LIMIT_EXCEEDED');

    if (!rmsResult.allowed) {
      console.warn(`[Webhook] Signal Rejected by RMS: ${rmsResult.reason}`);
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
        candleData: latestCandle,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: rmsResult.reason,
        rmsPassed: false,
        indicatorsPassed: false,
        filtersPassed: false,
        mlApproved: false,
        rawPayload: payload,
      });

      res.status(422).json({
        status: 'REJECTED',
        signalId,
        correlationId,
        stage: 'RMS',
        reason: rmsResult.reason,
      });
      return;
    }

    // 2. Fetch Candle Buffers & Evaluate GainzAlgo V2 Alpha Engine
    const indicatorEval = GainzAlgoEngine.evaluate(candles5m);
    const indicatorData = {
      ema9: indicatorEval.fastEma,
      ema21: indicatorEval.slowEma,
      rsi14: indicatorEval.rsi,
      adx14: 0,
      atr14: indicatorEval.atr,
      volumeSma20: 0,
    };

    // If indicator evaluation didn't trigger, log telemetry and reject
    if (indicatorEval.action !== action && process.env.BYPASS_INDICATOR_CHECK !== 'true') {
      const reason = `INDICATOR_MISMATCH: GainzAlgo engine calculated action (${indicatorEval.action}) vs signal action (${action})`;
      console.warn(`[Webhook] ${reason}`);

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
        candleData: latestCandle,
        indicators: indicatorData,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: reason,
        rmsPassed: true,
        indicatorsPassed: false,
        filtersPassed: false,
        mlApproved: false,
        rawPayload: payload,
      });

      res.status(422).json({
        status: 'REJECTED',
        signalId,
        correlationId,
        stage: 'INDICATORS',
        reason,
        indicators: indicatorEval,
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

    indicatorData.adx14 = filterEval.adxValue;
    indicatorData.volumeSma20 = filterEval.volumeRatio;

    if (!filterEval.passed) {
      console.warn(`[Webhook] Signal Rejected by Filters: ${filterEval.rejectionReason}`);
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
        candleData: latestCandle,
        indicators: indicatorData,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: filterEval.rejectionReason,
        rmsPassed: true,
        indicatorsPassed: true,
        filtersPassed: false,
        mlApproved: false,
        rawPayload: payload,
      });

      res.status(422).json({
        status: 'REJECTED',
        signalId,
        correlationId,
        stage: 'FILTERS',
        reason: filterEval.rejectionReason,
        filterData: filterEval,
      });
      return;
    }

    // 4. Construct Feature Vector for ML Microservice
    const atrNormalized = indicatorEval.atr > 0 ? (indicatorEval.atr / price) * 100 : 1.5;
    const oiBuildupScore = payload.oiBuildupScore || 0.5;

    const featureVector: MlFeatureVector = {
      volumeRatio20: filterEval.volumeRatio,
      adxValue: filterEval.adxValue,
      htfEmaDistance: filterEval.htfEmaDistance,
      rsiValue: indicatorEval.rsi,
      atrNormalized,
      oiBuildupScore,
    };

    // 5. Query ML Subsystem (Respects ML_MODE=advisory vs ML_MODE=gating)
    const mlResponse = await MlClient.predict(featureVector);
    filterChecks.mlPass = mlResponse.approved;

    if (!mlResponse.approved) {
      const reason = `ML_DISAPPROVED: Win probability P(Win)=${(mlResponse.probability * 100).toFixed(1)}% is below required threshold`;
      console.warn(`[Webhook] ${reason}`);

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
        candleData: latestCandle,
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
        rawPayload: payload,
        features: featureVector,
      });

      res.status(422).json({
        status: 'REJECTED',
        signalId,
        correlationId,
        stage: 'ML_GATEKEEPER',
        reason,
        probability: mlResponse.probability,
      });
      return;
    }

    // 6. Acquire Atomic Daily Lock (Strict 1 Trade per Day)
    const lockAcquired = await acquireDailyTradeLock(symbol);
    if (!lockAcquired && process.env.FORCE_RMS_BYPASS !== 'true') {
      const reason = 'DAILY_LIMIT_EXCEEDED: Another trade acquired atomic lock for today';
      console.warn(`[Webhook] ${reason}`);

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
        candleData: latestCandle,
        indicators: indicatorData,
        filterChecks,
        status: 'REJECTED',
        rejectionReason: reason,
        mlScore: mlResponse.probability,
        mlMode: mlResponse.mode,
        rmsPassed: false,
        rawPayload: payload,
      });

      res.status(429).json({
        status: 'REJECTED',
        signalId,
        correlationId,
        stage: 'ATOMIC_LOCK',
        reason,
      });
      return;
    }

    // 7. All Checks Passed -> Execute Paper Trade
    const tradeId = `TRADE_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const atr = indicatorEval.atr > 0 ? indicatorEval.atr : price * 0.01;

    let targetPrice: number;
    let stopLossPrice: number;

    if (action === 'BUY') {
      targetPrice = price + atr * 1.5;
      stopLossPrice = price - atr * 1.0;
    } else {
      targetPrice = price - atr * 1.5;
      stopLossPrice = price + atr * 1.0;
    }

    const tradeDateIST = getTodayISTDateString();
    const token = payload.symbol || 'NIFTY_ATM';
    const quantity = parseInt(process.env.NIFTY_LOT_SIZE || '50', 10);
    const slippagePercent = 0.002; // 0.2% slippage on option premium

    const grossEntryPrice = price;
    const netEntryPrice = action === 'BUY' ? grossEntryPrice * (1 + slippagePercent) : grossEntryPrice * (1 - slippagePercent);

    // Save Executed Signal Telemetry
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
      candleData: latestCandle,
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
      rawPayload: payload,
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

    console.log(`[Webhook] SUCCESS: Paper Trade Executed! Trade ID: ${tradeId} | Correlation: ${correlationId} | Strike: ${strike}`);

    res.status(201).json({
      status: 'EXECUTED',
      signalId,
      tradeId,
      correlationId,
      symbol,
      action,
      direction,
      selectedStrike: strike,
      grossEntryPrice,
      netEntryPrice,
      targetPrice,
      stopLossPrice,
      mlProbability: mlResponse.probability,
      tradeDateIST,
    });
  }
}
