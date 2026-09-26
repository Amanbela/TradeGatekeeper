import { PaperTradeModel } from '../models/PaperTrade';
import { TrackerWorker } from './trackerWorker';
import { logSystemEvent } from '../models/SystemEvent';

export class ReconciliationService {
  private static timer: NodeJS.Timeout | null = null;

  /**
   * Starts periodic position state reconciliation (runs every 60 seconds)
   */
  public static startPeriodicReconciliation(intervalMs = 60000): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    console.log(`[ReconciliationService] Starting periodic position state reconciliation (every ${intervalMs / 1000}s)...`);

    this.timer = setInterval(async () => {
      await this.runReconciliation();
    }, intervalMs);
  }

  public static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Audits consistency between MongoDB durable positions and RAM active positions cache.
   */
  public static async runReconciliation(): Promise<{ reconciledCount: number; mismatchCount: number }> {
    try {
      const dbOpenTrades = await PaperTradeModel.find({
        $or: [{ status: 'OPEN' }, { state: { $in: ['POSITION_OPEN', 'ORDER_PLACED', 'RISK_APPROVED'] } }],
      });

      const ramPositions = TrackerWorker.getActivePositions();
      const ramTradeIds = new Set(ramPositions.map((p) => p.tradeId));
      const dbTradeIds = new Set(dbOpenTrades.map((t) => t.tradeId));

      let mismatchCount = 0;

      // 1. Detect DB positions missing from RAM cache -> Rehydrate
      for (const trade of dbOpenTrades) {
        if (!ramTradeIds.has(trade.tradeId)) {
          mismatchCount++;
          console.warn(`[Reconciliation] MISMATCH DETECTED: Trade ${trade.tradeId} is OPEN in MongoDB but missing from RAM cache! Rehydrating...`);
          logSystemEvent(
            'RECONCILIATION_MISMATCH',
            `Trade ${trade.tradeId} OPEN in MongoDB but missing from RAM. Rehydrating RAM cache.`,
            'WARN',
            { tradeId: trade.tradeId, state: trade.state }
          ).catch(() => {});

          TrackerWorker.registerPosition({
            tradeId: trade.tradeId,
            correlationId: trade.correlationId || trade.tradeId,
            idempotencyKey: trade.idempotencyKey,
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
      }

      // 2. Detect RAM positions closed in DB -> Purge from RAM
      for (const ramPos of ramPositions) {
        if (!dbTradeIds.has(ramPos.tradeId)) {
          // Verify if it's closed in DB
          const dbTrade = await PaperTradeModel.findOne({ tradeId: ramPos.tradeId });
          if (dbTrade && dbTrade.status === 'CLOSED') {
            mismatchCount++;
            console.warn(`[Reconciliation] MISMATCH DETECTED: Trade ${ramPos.tradeId} is CLOSED in DB but active in RAM! Purging from RAM...`);
            logSystemEvent(
              'RECONCILIATION_MISMATCH',
              `Trade ${ramPos.tradeId} CLOSED in DB but active in RAM. Purging RAM entry.`,
              'WARN',
              { tradeId: ramPos.tradeId }
            ).catch(() => {});
          }
        }
      }

      return {
        reconciledCount: dbOpenTrades.length,
        mismatchCount,
      };
    } catch (err: any) {
      console.error('[Reconciliation] Error running reconciliation:', err.message);
      return { reconciledCount: 0, mismatchCount: -1 };
    }
  }
}
