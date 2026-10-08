import { Schema, model } from 'mongoose';

/** Append-only audit trail for security-relevant and trading-relevant actions. */
const auditLogSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    userEmail: String,
    action: { type: String, required: true, index: true },
    resource: String,
    resourceId: String,
    ip: String,
    userAgent: String,
    success: { type: Boolean, default: true },
    details: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  auditLogSchema.pre(op, function () {
    throw new Error('Audit log is append-only');
  });
}

export const AuditLogModel = model('AuditLog', auditLogSchema);
