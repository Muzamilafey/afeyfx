import { Schema, model } from 'mongoose';

const notificationSchema = new Schema(
  {
    channel: { type: String, enum: ['TELEGRAM', 'DASHBOARD'], default: 'DASHBOARD' },
    type: { type: String, required: true },
    title: String,
    message: String,
    severity: { type: String, enum: ['INFO', 'WARNING', 'CRITICAL'], default: 'INFO' },
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED', 'SKIPPED'], default: 'PENDING' },
    error: String,
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const NotificationModel = model('Notification', notificationSchema);
