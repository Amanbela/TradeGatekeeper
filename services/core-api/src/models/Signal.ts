import mongoose, { Schema, Document } from 'mongoose';
import { OHLCV, OptionDirection, TradeAction } from '../types';

export interface ISignal extends Document {
  signalId: string;
  symbol: string;
  action: TradeAction;
  direction: OptionDirection;
  spotPrice: number;
  timestamp: Date;
  timestampIST: string;
  timestampEpoch: number;
  selectedStrike?: string;
  candleData?: OHLCV;
  indicators?: {
    ema9: number;
    ema21: number;
    rsi14: number;
    adx14: number;
    atr14: number;
    volumeSma20: number;
  };
  filterChecks: {
    htfEmaPass: boolean;
    adxPass: boolean;
    volumeSurgePass: boolean;
    rmsWindowPass: boolean;
    dailyLimitPass: boolean;
    staleDataPass: boolean;
    killSwitchPass: boolean;
  };
  status: 'EXECUTED' | 'REJECTED';
  rejectionReason?: string;
  mlScore?: number;
  rmsPassed: boolean;
  indicatorsPassed: boolean;
  filtersPassed: boolean;
  mlApproved: boolean;
  mlProbability: number;
  rawPayload: Record<string, any>;
  features?: {
    volumeRatio20: number;
    adxValue: number;
    htfEmaDistance: number;
    rsiValue: number;
    atrNormalized: number;
    oiBuildupScore: number;
  };
}

const SignalSchema: Schema = new Schema(
  {
    signalId: { type: String, required: true, unique: true, index: true },
    symbol: { type: String, required: true, index: true },
    action: { type: String, required: true, enum: ['BUY', 'SELL'] },
    direction: { type: String, required: true, enum: ['CALL', 'PUT'] },
    spotPrice: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now, index: true },
    timestampIST: { type: String, required: true },
    timestampEpoch: { type: Number, required: true, index: true },
    selectedStrike: { type: String },
    candleData: {
      timestamp: Number,
      open: Number,
      high: Number,
      low: Number,
      close: Number,
      volume: Number,
    },
    indicators: {
      ema9: Number,
      ema21: Number,
      rsi14: Number,
      adx14: Number,
      atr14: Number,
      volumeSma20: Number,
    },
    filterChecks: {
      htfEmaPass: { type: Boolean, default: false },
      adxPass: { type: Boolean, default: false },
      volumeSurgePass: { type: Boolean, default: false },
      rmsWindowPass: { type: Boolean, default: false },
      dailyLimitPass: { type: Boolean, default: false },
      staleDataPass: { type: Boolean, default: true },
      killSwitchPass: { type: Boolean, default: true },
    },
    status: { type: String, required: true, enum: ['EXECUTED', 'REJECTED'], index: true },
    rejectionReason: { type: String },
    mlScore: { type: Number },
    rmsPassed: { type: Boolean, default: false },
    indicatorsPassed: { type: Boolean, default: false },
    filtersPassed: { type: Boolean, default: false },
    mlApproved: { type: Boolean, default: false },
    mlProbability: { type: Number, default: 0 },
    rawPayload: { type: Schema.Types.Mixed, default: {} },
    features: {
      volumeRatio20: { type: Number },
      adxValue: { type: Number },
      htfEmaDistance: { type: Number },
      rsiValue: { type: Number },
      atrNormalized: { type: Number },
      oiBuildupScore: { type: Number },
    },
  },
  {
    timestamps: true,
  }
);

export const SignalModel = mongoose.model<ISignal>('Signal', SignalSchema);
