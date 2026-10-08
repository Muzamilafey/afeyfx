import { Schema, model } from 'mongoose';

const systemEventSchema = new Schema(
  {
    type: { type: String, required: true, index: true },
    level: { type: String, enum: ['debug', 'info', 'warn', 'error', 'fatal'], default: 'info' },
    component: String,
    message: String,
    details: Schema.Types.Mixed,
  },
  { timestamps: true },
);
systemEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const SystemEventModel = model('SystemEvent', systemEventSchema);
