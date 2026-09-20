import { Router, Request, Response } from 'express';
import { WebhookController } from '../controllers/webhookController';
import { PaperTradeModel } from '../models/PaperTrade';
import { SignalModel } from '../models/Signal';
import { TrackerWorker } from '../services/trackerWorker';
import { getCandleManager } from '../engine/candleManager';
import { MlClient } from '../services/mlClient';
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

  // Update candle manager
  const candleMgr = getCandleManager(tickData.symbol);
  candleMgr.processTick(tickData);

  // Update position tracker for TP1 / SL checks
  await TrackerWorker.onTick(tickData);

  res.status(200).json({ status: 'TICK_PROCESSED', symbol: tickData.symbol, price: tickData.price });
});

// Get historical paper trades
router.get('/trades', async (req: Request, res: Response) => {
  try {
    const { status, limit = 50 } = req.query;
    const filter: any = {};
    if (status) filter.status = status;

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

// Get raw signal history
router.get('/signals', async (req: Request, res: Response) => {
  try {
    const { limit = 50 } = req.query;
    const signals = await SignalModel.find()
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
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'UP',
    system: 'TradeGatekeeper Core API',
    timestamp: new Date().toISOString(),
    activePositions: TrackerWorker.getActivePositions().length,
  });
});

export default router;
