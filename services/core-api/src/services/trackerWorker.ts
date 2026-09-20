import WebSocket from 'ws';
import { ActivePosition, TickData } from '../types';
import { PaperTradeModel } from '../models/PaperTrade';
import { setLastExitTimestamp } from '../config/redis';
import { getCachedSession } from '../config/smartApi';

export class TrackerWorker {
  private static activePositions: Map<string, ActivePosition> = new Map();
  private static wsClient: WebSocket | null = null;
  private static checkIntervalTimer: NodeJS.Timeout | null = null;

  /**
   * Initialize TrackerWorker and sync any OPEN trades from MongoDB into RAM
   */
  public static async init(): Promise<void> {
    console.log('[TrackerWorker] Initializing active trades tracker...');
    try {
      const openTrades = await PaperTradeModel.find({ status: 'OPEN' });
      for (const trade of openTrades) {
        this.registerPosition({
          tradeId: trade.tradeId,
          symbol: trade.symbol,
          token: trade.token,
          action: trade.action,
          entryPrice: trade.entryPrice,
          targetPrice: trade.targetPrice,
          stopLossPrice: trade.stopLossPrice,
          entryTimestamp: trade.entryTimestamp.getTime(),
          maxHoldTimeMinutes: 35,
          featureVector: trade.features,
        });
      }
      console.log(`[TrackerWorker] Loaded ${openTrades.length} OPEN paper position(s) into RAM.`);

      // Start periodic 35-minute Theta Decay Time-Stop checker (runs every 15 seconds)
      if (!this.checkIntervalTimer) {
        this.checkIntervalTimer = setInterval(() => {
          this.checkTimeStops();
        }, 15000);
      }
    } catch (err) {
      console.error('[TrackerWorker] Error initializing tracker:', err);
    }
  }

  /**
   * Registers a newly opened paper trade position in RAM
   */
  public static registerPosition(position: ActivePosition): void {
    this.activePositions.set(position.tradeId, position);
    console.log(
      `[TrackerWorker] Position Registered: ${position.action} ${position.symbol} @ ${position.entryPrice} | TP1: ${position.targetPrice} | SL: ${position.stopLossPrice}`
    );
  }

  /**
   * Processes live tick updates against active paper positions
   */
  public static async onTick(tick: TickData): Promise<void> {
    for (const [tradeId, pos] of this.activePositions.entries()) {
      if (pos.symbol === tick.symbol || pos.token === tick.token) {
        const currentPrice = tick.price;

        if (pos.action === 'BUY') {
          // Target 1 Hit
          if (currentPrice >= pos.targetPrice) {
            await this.closePosition(tradeId, currentPrice, 'TARGET_HIT', 1);
            continue;
          }
          // Stop Loss Hit
          if (currentPrice <= pos.stopLossPrice) {
            await this.closePosition(tradeId, currentPrice, 'SL_HIT', 0);
            continue;
          }
        } else if (pos.action === 'SELL') {
          // Target 1 Hit
          if (currentPrice <= pos.targetPrice) {
            await this.closePosition(tradeId, currentPrice, 'TARGET_HIT', 1);
            continue;
          }
          // Stop Loss Hit
          if (currentPrice >= pos.stopLossPrice) {
            await this.closePosition(tradeId, currentPrice, 'SL_HIT', 0);
            continue;
          }
        }
      }
    }
  }

  /**
   * Periodic evaluation for Theta Decay Dynamic Time-Stop (35 Minutes Max Hold)
   */
  public static async checkTimeStops(): Promise<void> {
    const now = Date.now();
    const maxHoldMs = 35 * 60 * 1000; // 35 Minutes

    for (const [tradeId, pos] of this.activePositions.entries()) {
      const duration = now - pos.entryTimestamp;
      if (duration >= maxHoldMs) {
        console.log(`[TrackerWorker] Dynamic Time-Stop Triggered (35 mins elapsed) for trade ${tradeId}`);
        // Assume current exit price is breakeven or entry price if tick not updated
        const exitPrice = pos.entryPrice;
        await this.closePosition(tradeId, exitPrice, 'TIME_EXIT', 0);
      }
    }
  }

  /**
   * Closes a paper trade, records output in MongoDB, sets anti-whipsaw lock, and updates RAM
   */
  public static async closePosition(
    tradeId: string,
    exitPrice: number,
    reason: 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT' | 'FORCE_EXIT',
    outcomeLabel: number
  ): Promise<void> {
    const pos = this.activePositions.get(tradeId);
    if (!pos) return;

    const pnlPoints =
      pos.action === 'BUY' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;

    console.log(
      `[TrackerWorker] Closing Trade ${tradeId} | Reason: ${reason} | Exit: ${exitPrice} | PnL Points: ${pnlPoints.toFixed(2)}`
    );

    try {
      await PaperTradeModel.findOneAndUpdate(
        { tradeId },
        {
          status: 'CLOSED',
          exitPrice,
          exitTimestamp: new Date(),
          exitReason: reason,
          outcomeLabel,
          pnlPoints,
        }
      );

      // Set anti-whipsaw cooldown in Redis (30 mins lockout)
      await setLastExitTimestamp(pos.symbol, Date.now());
    } catch (err) {
      console.error(`[TrackerWorker] Error saving closed trade ${tradeId} to MongoDB:`, err);
    } finally {
      this.activePositions.delete(tradeId);
    }
  }

  public static getActivePositions(): ActivePosition[] {
    return Array.from(this.activePositions.values());
  }

  /**
   * Connects to SmartAPI WebSocket for live stream
   */
  public static connectSmartApiWebSocket(): void {
    const session = getCachedSession();
    if (!session || session.jwtToken.startsWith('mock')) {
      console.log('[TrackerWorker] SmartAPI Live Socket skipped (Using internal tick stream).');
      return;
    }

    try {
      const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?clientCode=${session.clientCode}&feedToken=${session.feedToken}`;
      this.wsClient = new WebSocket(wsUrl);

      this.wsClient.on('open', () => {
        console.log('[TrackerWorker] Connected to SmartAPI WebSocket stream.');
      });

      this.wsClient.on('message', (data: WebSocket.Data) => {
        try {
          // Parse tick packet (binary/json format from SmartAPI)
          const tickStr = data.toString();
          const parsed = JSON.parse(tickStr);
          if (parsed && parsed.token && parsed.last_traded_price) {
            const tick: TickData = {
              symbol: parsed.symbol || 'NIFTY',
              token: parsed.token,
              price: parsed.last_traded_price / 100, // convert paise to rupees if necessary
              volume: parsed.volume || 1,
              timestamp: Date.now(),
            };
            this.onTick(tick);
          }
        } catch (e) {
          // Ignore binary frame errors in streaming
        }
      });

      this.wsClient.on('error', (err) => {
        console.error('[TrackerWorker] WebSocket error:', err.message);
      });

      this.wsClient.on('close', () => {
        console.warn('[TrackerWorker] WebSocket closed. Retrying in 10s...');
        setTimeout(() => this.connectSmartApiWebSocket(), 10000);
      });
    } catch (e: any) {
      console.error('[TrackerWorker] Exception initiating WebSocket:', e.message);
    }
  }
}
