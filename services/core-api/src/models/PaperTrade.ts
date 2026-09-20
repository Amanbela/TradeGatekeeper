import mongoose, { Schema, Document } from 'mongoose';
import { OptionDirection, TradeAction, TradeState } from '../types';

export interface IPaperTrade extends Document {
  tradeId: string;
  symbol: string;
  token: string;
  action: TradeAction;
  direction: OptionDirection;
  selectedStrike: string;
  quantity: number;

  // Lifecycle state machine
  state: TradeState;
  status: 'OPEN' | 'CLOSED';
  stateTimestamps: {
    signalDetectedAt: Date;
    riskApprovedAt?: Date;
    orderPlacedAt?: Date;
    positionOpenedAt?: Date;
    exitTriggeredAt?: Date;
    positionClosedAt?: Date;
  };

  // Entry Execution
  entryPrice: number; // net entry price for backward compatibility
  grossEntryPrice: number;
  netEntryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  entryTimestamp: Date;

  // Exit Execution
  exitPrice?: number; // net exit price for backward compatibility
  grossExitPrice?: number;
  netExitPrice?: number;
  exitTimestamp?: Date;
  exitReason: 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT' | 'FORCE_EXIT' | 'NONE';
  outcomeLabel?: number; // 1 = Target Hit (Win), 0 = SL / Time Exit (Loss)

  // Financial Frictions & PnL Metrics
  slippagePercent: number; // default 0.002 (0.2%)
  grossPnLPoints?: number;
  grossPnLAmount?: number;
  brokerage?: number;
  sttTax?: number;
  exchangeCharges?: number;
  stampDuty?: number;
  totalTaxesAndCharges?: number;
  pnlPoints?: number; // net PnL points
  netRealizedPnL?: number;

  mlProbability: number;
  tradeDateIST: string; // YYYY-MM-DD
  features: {
    volumeRatio20: number;
    adxValue: number;
    htfEmaDistance: number;
    rsiValue: number;
    atrNormalized: number;
    oiBuildupScore: number;
  };
}

const PaperTradeSchema: Schema = new Schema(
  {
    tradeId: { type: String, required: true, unique: true, index: true },
    symbol: { type: String, required: true, index: true },
    token: { type: String, required: true },
    action: { type: String, required: true, enum: ['BUY', 'SELL'] },
    direction: { type: String, required: true, enum: ['CALL', 'PUT'], default: 'CALL' },
    selectedStrike: { type: String, required: true, default: 'ATM' },
    quantity: { type: Number, required: true, default: 50 },

    // State machine
    state: {
      type: String,
      required: true,
      enum: [
        'SIGNAL_DETECTED',
        'RISK_APPROVED',
        'ORDER_PLACED',
        'POSITION_OPEN',
        'EXIT_TRIGGERED',
        'POSITION_CLOSED',
      ],
      default: 'POSITION_OPEN',
      index: true,
    },
    status: { type: String, required: true, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    stateTimestamps: {
      signalDetectedAt: { type: Date, default: Date.now },
      riskApprovedAt: { type: Date },
      orderPlacedAt: { type: Date },
      positionOpenedAt: { type: Date, default: Date.now },
      exitTriggeredAt: { type: Date },
      positionClosedAt: { type: Date },
    },

    // Entry execution
    entryPrice: { type: Number, required: true },
    grossEntryPrice: { type: Number, required: true },
    netEntryPrice: { type: Number, required: true },
    targetPrice: { type: Number, required: true },
    stopLossPrice: { type: Number, required: true },
    entryTimestamp: { type: Date, default: Date.now, index: true },

    // Exit execution
    exitPrice: { type: Number },
    grossExitPrice: { type: Number },
    netExitPrice: { type: Number },
    exitTimestamp: { type: Date },
    exitReason: {
      type: String,
      enum: ['TARGET_HIT', 'SL_HIT', 'TIME_EXIT', 'FORCE_EXIT', 'NONE'],
      default: 'NONE',
    },
    outcomeLabel: { type: Number },

    // Financial frictions & audit metrics
    slippagePercent: { type: Number, default: 0.002 },
    grossPnLPoints: { type: Number },
    grossPnLAmount: { type: Number },
    brokerage: { type: Number, default: 0 },
    sttTax: { type: Number, default: 0 },
    exchangeCharges: { type: Number, default: 0 },
    stampDuty: { type: Number, default: 0 },
    totalTaxesAndCharges: { type: Number, default: 0 },
    pnlPoints: { type: Number },
    netRealizedPnL: { type: Number },

    mlProbability: { type: Number, required: true },
    tradeDateIST: { type: String, required: true, index: true },
    features: {
      volumeRatio20: { type: Number, required: true },
      adxValue: { type: Number, required: true },
      htfEmaDistance: { type: Number, required: true },
      rsiValue: { type: Number, required: true },
      atrNormalized: { type: Number, required: true },
      oiBuildupScore: { type: Number, required: true },
    },
  },
  {
    timestamps: true,
  }
);

export const PaperTradeModel = mongoose.model<IPaperTrade>('PaperTrade', PaperTradeSchema);
