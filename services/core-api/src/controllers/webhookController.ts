import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SignalPayload, MlFeatureVector } from '../types';
import { RMSService } from '../services/rmsService';
import { getCandleManager } from '../engine/candleManager';
import { GainzAlgoEngine } from '../engine/gainzAlgoEngine';
import { OptionFilters } from '../engine/optionFilters';
import { MlClient } from '../services/mlClient';
import { acquireDailyTradeLock, getTodayISTDateString } from '../config/redis';
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

    console.log(`[Webhook] Ingesting Signal: ${action} ${symbol} @ ${price}`);

    // 1. RMS Check
    const rmsResult = await RMSService.evaluateRMS(symbol);
    if (!rmsResult.allowed) {
      console.warn(`[Webhook] Signal Rejected by RMS: ${rmsResult.reason}`);
      await SignalModel.create({
        symbol,
        action,
        price,
        rmsPassed: false,
        rejectionReason: rmsResult.reason,
        rawPayload: payload,
      });

      res.status(422).json({
        status: 'REJECTED',
        stage: 'RMS',
        reason: rmsResult.reason,
      });
      return;
    }

    // 2. Fetch Candle Buffers & Evaluate GainzAlgo V2 Alpha Engine
    const candleMgr = getCandleManager(symbol);
    const candles5m = candleMgr.get5mCandles();
    const candles15m = candleMgr.get15mCandles();

    const indicatorEval = GainzAlgoEngine.evaluate(candles5m);

    // If indicator evaluation didn't trigger, log and reject
    if (indicatorEval.action !== action && process.env.BYPASS_INDICATOR_CHECK !== 'true') {
      const reason = `INDICATOR_MISMATCH: GainzAlgo engine calculated action (${indicatorEval.action}) vs signal action (${action})`;
      console.warn(`[Webhook] ${reason}`);
      await SignalModel.create({
        symbol,
        action,
        price,
        rmsPassed: true,
        indicatorsPassed: false,
        rejectionReason: reason,
        rawPayload: payload,
      });

      res.status(422).json({
        status: 'REJECTED',
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

    if (!filterEval.passed) {
      console.warn(`[Webhook] Signal Rejected by Filters: ${filterEval.rejectionReason}`);
      await SignalModel.create({
        symbol,
        action,
        price,
        rmsPassed: true,
        indicatorsPassed: true,
        filtersPassed: false,
        rejectionReason: filterEval.rejectionReason,
        rawPayload: payload,
      });

      res.status(422).json({
        status: 'REJECTED',
        stage: 'FILTERS',
        reason: filterEval.rejectionReason,
        filterData: filterEval,
      });
      return;
    }

    // 4. Construct Feature Vector for ML Gatekeeper
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

    // 5. Query Python ML Subsystem (P(Win) >= 0.80)
    const mlResponse = await MlClient.predict(featureVector);

    if (!mlResponse.approved) {
      const reason = `ML_DISAPPROVED: Win probability P(Win)=${(mlResponse.probability * 100).toFixed(1)}% is below required 80.0% threshold`;
      console.warn(`[Webhook] ${reason}`);

      await SignalModel.create({
        symbol,
        action,
        price,
        rmsPassed: true,
        indicatorsPassed: true,
        filtersPassed: true,
        mlApproved: false,
        mlProbability: mlResponse.probability,
        rejectionReason: reason,
        rawPayload: payload,
        features: featureVector,
      });

      res.status(422).json({
        status: 'REJECTED',
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

      await SignalModel.create({
        symbol,
        action,
        price,
        rmsPassed: false,
        rejectionReason: reason,
        rawPayload: payload,
      });

      res.status(429).json({
        status: 'REJECTED',
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

    const paperTrade = await PaperTradeModel.create({
      tradeId,
      symbol,
      token,
      action,
      entryPrice: price,
      targetPrice,
      stopLossPrice,
      entryTimestamp: new Date(),
      status: 'OPEN',
      exitReason: 'NONE',
      mlProbability: mlResponse.probability,
      tradeDateIST,
      features: featureVector,
    });

    // Save successful signal log
    await SignalModel.create({
      symbol,
      action,
      price,
      rmsPassed: true,
      indicatorsPassed: true,
      filtersPassed: true,
      mlApproved: true,
      mlProbability: mlResponse.probability,
      rawPayload: payload,
      features: featureVector,
    });

    // Register active paper trade in RAM worker
    TrackerWorker.registerPosition({
      tradeId,
      symbol,
      token,
      action,
      entryPrice: price,
      targetPrice,
      stopLossPrice,
      entryTimestamp: Date.now(),
      maxHoldTimeMinutes: 35,
      featureVector,
    });

    console.log(`[Webhook] SUCCESS: Paper Trade Executed! Trade ID: ${tradeId}`);

    res.status(201).json({
      status: 'EXECUTED',
      tradeId,
      symbol,
      action,
      entryPrice: price,
      targetPrice,
      stopLossPrice,
      mlProbability: mlResponse.probability,
      tradeDateIST,
    });
  }
}
