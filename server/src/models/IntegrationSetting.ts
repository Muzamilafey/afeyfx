import { Schema, model } from 'mongoose';

/**
 * Integration settings saved from the admin console. Each document overrides one environment
 * variable at runtime. Secret values are AES-256-GCM encrypted (ENCRYPTION_KEY) and never
 * returned to a browser.
 */
const integrationSettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: String,
    valueEnc: String,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const IntegrationSettingModel = model('IntegrationSetting', integrationSettingSchema);
