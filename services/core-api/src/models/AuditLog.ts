import mongoose, { Schema, Document } from 'mongoose';

export interface IAuditLog extends Document {
  action: string;
  performedBy: string;
  details: Record<string, any>;
  ipAddress?: string;
  timestamp: Date;
}

const AuditLogSchema: Schema = new Schema(
  {
    action: { type: String, required: true, index: true },
    performedBy: { type: String, required: true, default: 'SYSTEM' },
    details: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
  }
);

export const AuditLogModel = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);

export async function logAuditRecord(
  action: string,
  details: Record<string, any>,
  performedBy: string = 'ADMIN',
  ipAddress?: string
): Promise<void> {
  try {
    console.log(`[AuditLog] ${action} performed by ${performedBy}:`, JSON.stringify(details));
    await AuditLogModel.create({
      action,
      performedBy,
      details,
      ipAddress,
      timestamp: new Date(),
    });
  } catch (err: any) {
    console.error(`[AuditLog] Failed to persist audit record: ${err.message}`);
  }
}
