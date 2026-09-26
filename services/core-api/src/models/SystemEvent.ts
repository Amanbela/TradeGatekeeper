import mongoose, { Schema, Document } from 'mongoose';

export type SystemEventType =
  | 'WEBSOCKET_CONNECTED'
  | 'WEBSOCKET_DISCONNECTED'
  | 'REDIS_UNAVAILABLE'
  | 'REDIS_RECOVERED'
  | 'MONGO_UNAVAILABLE'
  | 'MONGO_RECOVERED'
  | 'ML_UNAVAILABLE'
  | 'ML_RECOVERED'
  | 'BROKER_API_UNAVAILABLE'
  | 'KILL_SWITCH_ACTIVATED'
  | 'KILL_SWITCH_DEACTIVATED'
  | 'APPLICATION_RESTARTED'
  | 'RECOVERY_PERFORMED'
  | 'RECONCILIATION_MISMATCH';

export interface ISystemEvent extends Document {
  eventType: SystemEventType;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  message: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

const SystemEventSchema: Schema = new Schema(
  {
    eventType: { type: String, required: true, index: true },
    severity: { type: String, required: true, enum: ['INFO', 'WARN', 'ERROR', 'CRITICAL'], default: 'INFO' },
    message: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
  }
);

export const SystemEventModel = mongoose.model<ISystemEvent>('SystemEvent', SystemEventSchema);

export async function logSystemEvent(
  eventType: SystemEventType,
  message: string,
  severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL' = 'INFO',
  metadata: Record<string, any> = {}
): Promise<void> {
  try {
    console.log(`[SystemEvent][${severity}][${eventType}] ${message}`);
    await SystemEventModel.create({
      eventType,
      severity,
      message,
      metadata,
      timestamp: new Date(),
    });
  } catch (err: any) {
    console.error(`[SystemEvent] Failed to log event to MongoDB: ${err.message}`);
  }
}
