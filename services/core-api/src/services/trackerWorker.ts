import WebSocket from 'ws';
import { ActivePosition, FinancialFrictions, TickData, TradeAction } from '../types';
import { PaperTradeModel } from '../models/PaperTrade';
import { setLastExitTimestamp } from '../config/redis';
import { getCachedSession } from '../config/smartApi';
import { getCandleManager } from '../engine/candleManager';

export class TrackerWorker {
  private static activePositions: Map<string, ActivePosition> = new Map();
  private static wsClient: WebSocket | null = null;
  private static checkIntervalTimer: NodeJS.Timeout | null = null;

  /**
   * Helper to compute realistic option trading frictions (slippage, STT, brokerage, exchange charges, GST)
   */
  public static calculateFrictions(
    action: TradeAction,
    grossEntryPrice: number,
    grossExitPrice: number,
    quantity: number = 50,
    slippagePercent: number = 0.002
  ): FinancialFrictions {
    let netEntryPrice: number;
    let netExitPrice: number;

    if (action === 'BUY') {
      // Buying option: buy slightly higher due to ask spread
      netEntryPrice = grossEntryPrice * (1 + slippagePercent);
      // Exiting (selling option): sell slightly lower due to bid spread
      netExitPrice = grossExitPrice * (1 - slippagePercent);
    } else {
      // Selling option: sell slightly lower
      netEntryPrice = grossEntryPrice * (1 - slippagePercent);
      // Exiting (buying back option): buy slightly higher
      netExitPrice = grossExitPrice * (1 + slippagePercent);
    }

    const buyTurnover = (action === 'BUY' ? netEntryPrice : netExitPrice) * quantity;
    const sellTurnover = (action === 'BUY' ? netExitPrice : netEntryPrice) * quantity;
    const totalTurnover = buyTurnover + sellTurnover;

    // ₹20 flat brokerage per order (₹40 round trip)
    const brokerage = 40.0;

    // STT/CTT: 0.1% on option sell turnover
    const sttTax = sellTurnover * 0.001;

    // Stamp Duty: 0.003% on option buy turnover
    const stampDuty = buyTurnover * 0.00003;

    // Exchange turnover charges: ~0.05% of turnover
    const exchangeCharges = totalTurnover * 0.0005;

    // GST: 18% on (brokerage + exchange charges)
    const gst = (brokerage + exchangeCharges) * 0.18;

    const totalTaxesAndCharges = brokerage + sttTax + stampDuty + exchangeCharges + gst;

    const grossPnLPoints = action === 'BUY' ? grossExitPrice - grossEntryPrice : grossEntryPrice - grossExitPrice;
    const grossPnLAmount = grossPnLPoints * quantity;

    const netPnLPoints = action === 'BUY' ? netExitPrice - netEntryPrice : netEntryPrice - netExitPrice;
    const netRealizedPnL = netPnLPoints * quantity - totalTaxesAndCharges;

    return {
      slippagePercent,
      grossEntryPrice,
      netEntryPrice,
      grossExitPrice,
      netExitPrice,
      quantity,
      grossPnLPoints,
      grossPnLAmount,
      brokerage,
      sttTax,
      exchangeCharges,
      stampDuty,
      totalTaxesAndCharges,
      netRealizedPnL,
    };
  }

  /**
   * Initialize TrackerWorker and restore OPEN paper trades from MongoDB with exact elapsed durations
   */
  public static async init(): Promise<void> {
    console.log('[TrackerWorker] Initializing active trades tracker & state machine recovery...');
    try {
      const openTrades = await PaperTradeModel.find({
        $or: [{ status: 'OPEN' }, { state: { $in: ['POSITION_OPEN', 'ORDER_PLACED'] } }],
      });

      for (const trade of openTrades) {
        this.registerPosition({
          tradeId: trade.tradeId,
          symbol: trade.symbol,
          token: trade.token,
          action: trade.action,
          entryPrice: trade.entryPrice,
          grossEntryPrice: trade.grossEntryPrice || trade.entryPrice,
          targetPrice: trade.targetPrice,
          stopLossPrice: trade.stopLossPrice,
          entryTimestamp: trade.entryTimestamp.getTime(),
          maxHoldTimeMinutes: 35,
          featureVector: trade.features,
          quantity: trade.quantity || 50,
          selectedStrike: trade.selectedStrike || 'ATM',
        });
      }
      console.log(`[TrackerWorker] Restored ${openTrades.length} OPEN position(s) into RAM state machine.`);

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
      `[TrackerWorker] Position Active [${position.selectedStrike}]: ${position.action} ${position.symbol} @ Gross: ${position.grossEntryPrice} (Net: ${position.entryPrice.toFixed(2)}) | TP1: ${position.targetPrice.toFixed(2)} | SL: ${position.stopLossPrice.toFixed(2)}`
    );
  }

  /**
   * Processes live tick updates against active paper positions and updates CandleManager tick timestamp
   */
  public static async onTick(tick: TickData): Promise<void> {
    // Update tick feed timestamp in CandleManager for stale data kill switch
    const candleMgr = getCandleManager(tick.symbol);
    candleMgr.processTick(tick);

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
        const exitPrice = pos.grossEntryPrice;
        await this.closePosition(tradeId, exitPrice, 'TIME_EXIT', 0);
      }
    }
  }

  /**
   * Closes a paper trade, applies financial frictions, updates state machine to POSITION_CLOSED, and persists to MongoDB
   */
  public static async closePosition(
    tradeId: string,
    grossExitPrice: number,
    reason: 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT' | 'FORCE_EXIT',
    outcomeLabel: number
  ): Promise<void> {
    const pos = this.activePositions.get(tradeId);
    if (!pos) return;

    const frictions = this.calculateFrictions(
      pos.action,
      pos.grossEntryPrice,
      grossExitPrice,
      pos.quantity
    );

    console.log(
      `[TrackerWorker] Closing Trade ${tradeId} [${reason}] | Gross Exit: ${grossExitPrice} (Net Exit: ${frictions.netExitPrice.toFixed(2)}) | Net PnL: ₹${frictions.netRealizedPnL.toFixed(2)} (Charges: ₹${frictions.totalTaxesAndCharges.toFixed(2)})`
    );

    try {
      await PaperTradeModel.findOneAndUpdate(
        { tradeId },
        {
          state: 'POSITION_CLOSED',
          status: 'CLOSED',
          exitPrice: frictions.netExitPrice,
          grossExitPrice: frictions.grossExitPrice,
          netExitPrice: frictions.netExitPrice,
          exitTimestamp: new Date(),
          exitReason: reason,
          outcomeLabel,
          pnlPoints: frictions.netExitPrice - frictions.netEntryPrice,
          grossPnLPoints: frictions.grossPnLPoints,
          grossPnLAmount: frictions.grossPnLAmount,
          brokerage: frictions.brokerage,
          sttTax: frictions.sttTax,
          exchangeCharges: frictions.exchangeCharges,
          stampDuty: frictions.stampDuty,
          totalTaxesAndCharges: frictions.totalTaxesAndCharges,
          netRealizedPnL: frictions.netRealizedPnL,
          'stateTimestamps.exitTriggeredAt': new Date(),
          'stateTimestamps.positionClosedAt': new Date(),
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
   * Connects to SmartAPI WebSocket for live market stream
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
          const tickStr = data.toString();
          const parsed = JSON.parse(tickStr);
          if (parsed && parsed.token && parsed.last_traded_price) {
            const tick: TickData = {
              symbol: parsed.symbol || 'NIFTY',
              token: parsed.token,
              price: parsed.last_traded_price / 100,
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
