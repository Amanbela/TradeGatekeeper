import { Router, Request, Response } from 'express';
import { WebhookController } from '../controllers/webhookController';
import { PaperTradeModel } from '../models/PaperTrade';
import { SignalModel } from '../models/Signal';
import { TrackerWorker } from '../services/trackerWorker';
import { getCandleManager } from '../engine/candleManager';
import { MlClient } from '../services/mlClient';
import { setKillSwitchState, isKillSwitchActive } from '../config/redis';
import { TickData } from '../types';

const router = Router();

// Ingest trading signal (webhook trigger)
router.post('/signal', WebhookController.handleSignal);

// Ingest live / mock tick stream
router.post('/tick', async (req: Request, res: Response) => {
  const tick: TickData = req.body;
  if (!tick.price || !tick.symbol) {
    res.status(400).json({ error: 'INVALID_TICK_PAYLOAD' });
    return;
  }

  const timestamp = tick.timestamp || Date.now();
  const tickData: TickData = {
    symbol: tick.symbol,
    token: tick.token || tick.symbol,
    price: tick.price,
    volume: tick.volume || 1,
    timestamp,
  };

  // Update position tracker for TP1 / SL checks & tick timestamp
  await TrackerWorker.onTick(tickData);

  res.status(200).json({ status: 'TICK_PROCESSED', symbol: tickData.symbol, price: tickData.price });
});

// Toggle emergency manual kill switch
router.post('/kill-switch', async (req: Request, res: Response) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'INVALID_PAYLOAD', message: 'Boolean field "active" is required.' });
    return;
  }

  await setKillSwitchState(active);
  res.json({
    status: 'SUCCESS',
    killSwitchActive: active,
    message: active ? 'Emergency Kill Switch ACTIVATED. All new trades blocked.' : 'Emergency Kill Switch DEACTIVATED.',
  });
});

// Get emergency manual kill switch & data feed health status
router.get('/kill-switch', async (req: Request, res: Response) => {
  const active = await isKillSwitchActive();
  const candleMgr = getCandleManager('NIFTY');
  const isFresh = candleMgr.isTickFeedFresh(30000);
  const lastTick = candleMgr.getLastTickTimestamp();

  res.json({
    killSwitchActive: active,
    tickFeedFresh: isFresh,
    lastTickTimestamp: lastTick > 0 ? new Date(lastTick).toISOString() : 'NO_TICKS_RECEIVED_YET',
    secondsSinceLastTick: lastTick > 0 ? ((Date.now() - lastTick) / 1000).toFixed(1) : null,
  });
});

// Get historical paper trades with financial audit metrics
router.get('/trades', async (req: Request, res: Response) => {
  try {
    const { status, state, limit = 50 } = req.query;
    const filter: any = {};
    if (status) filter.status = status;
    if (state) filter.state = state;

    const trades = await PaperTradeModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit));
    res.json({ count: trades.length, trades });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get active open positions in RAM
router.get('/positions', (req: Request, res: Response) => {
  const positions = TrackerWorker.getActivePositions();
  res.json({ count: positions.length, positions });
});

// Get comprehensive signal telemetry history
router.get('/signals', async (req: Request, res: Response) => {
  try {
    const { status, limit = 50 } = req.query;
    const filter: any = {};
    if (status) filter.status = status;

    const signals = await SignalModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit));
    res.json({ count: signals.length, signals });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger ML Model Retraining
router.post('/ml/train', async (req: Request, res: Response) => {
  try {
    const result = await MlClient.triggerRetraining();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
router.get('/health', async (req: Request, res: Response) => {
  const candleMgr = getCandleManager('NIFTY');
  const killSwitch = await isKillSwitchActive();

  res.json({
    status: 'UP',
    system: 'TradeGatekeeper Core API',
    timestamp: new Date().toISOString(),
    killSwitchActive: killSwitch,
    tickFeedFresh: candleMgr.isTickFeedFresh(30000),
    activePositions: TrackerWorker.getActivePositions().length,
  });
});

export default router;
