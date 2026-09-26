import mongoose, { Schema, Document } from 'mongoose';

export interface ISystemState extends Document {
  key: string; // 'GLOBAL_STATE'
  killSwitchActive: boolean;
  killSwitchReason?: string;
  killSwitchUpdatedAt?: Date;
  dailyTradeLocked: boolean;
  dailyTradeLockedDateIST?: string;
  consecutiveLosses: number;
  dailyRealizedLoss: number;
  dailyUnrealizedLoss: number;
  lastResetDateIST: string;
  updatedAt: Date;
}

const SystemStateSchema: Schema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'GLOBAL_STATE' },
    killSwitchActive: { type: Boolean, required: true, default: false },
    killSwitchReason: { type: String },
    killSwitchUpdatedAt: { type: Date, default: Date.now },
    dailyTradeLocked: { type: Boolean, default: false },
    dailyTradeLockedDateIST: { type: String },
    consecutiveLosses: { type: Number, default: 0 },
    dailyRealizedLoss: { type: Number, default: 0 },
    dailyUnrealizedLoss: { type: Number, default: 0 },
    lastResetDateIST: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

export const SystemStateModel = mongoose.model<ISystemState>('SystemState', SystemStateSchema);
