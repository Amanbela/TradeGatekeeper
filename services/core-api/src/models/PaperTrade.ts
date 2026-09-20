import mongoose, { Schema, Document } from 'mongoose';

export interface IPaperTrade extends Document {
  tradeId: string;
  symbol: string;
  token: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  entryTimestamp: Date;
  exitTimestamp?: Date;
  status: 'OPEN' | 'CLOSED';
  exitReason: 'TARGET_HIT' | 'SL_HIT' | 'TIME_EXIT' | 'FORCE_EXIT' | 'NONE';
  outcomeLabel?: number; // 1 = Target Hit (Win), 0 = SL / Time Exit (Loss)
  exitPrice?: number;
  pnlPoints?: number;
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
    entryPrice: { type: Number, required: true },
    targetPrice: { type: Number, required: true },
    stopLossPrice: { type: Number, required: true },
    entryTimestamp: { type: Date, default: Date.now, index: true },
    exitTimestamp: { type: Date },
    status: { type: String, required: true, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    exitReason: {
      type: String,
      enum: ['TARGET_HIT', 'SL_HIT', 'TIME_EXIT', 'FORCE_EXIT', 'NONE'],
      default: 'NONE',
    },
    outcomeLabel: { type: Number },
    exitPrice: { type: Number },
    pnlPoints: { type: Number },
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
