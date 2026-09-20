import mongoose, { Schema, Document } from 'mongoose';

export interface ISignal extends Document {
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  timestamp: Date;
  rmsPassed: boolean;
  indicatorsPassed: boolean;
  filtersPassed: boolean;
  mlApproved: boolean;
  mlProbability: number;
  rejectionReason?: string;
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
    symbol: { type: String, required: true, index: true },
    action: { type: String, required: true, enum: ['BUY', 'SELL'] },
    price: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now, index: true },
    rmsPassed: { type: Boolean, default: false },
    indicatorsPassed: { type: Boolean, default: false },
    filtersPassed: { type: Boolean, default: false },
    mlApproved: { type: Boolean, default: false },
    mlProbability: { type: Number, default: 0 },
    rejectionReason: { type: String },
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
