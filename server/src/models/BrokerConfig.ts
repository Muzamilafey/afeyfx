import { Schema, model } from 'mongoose';

/**
 * Where traders' REAL-account orders are executed, per asset class, and broker credentials.
 * Singleton (key = 'brokers'). Default: everything internal. Secrets are encrypted at rest.
 */
const route = { type: String, enum: ['internal', 'deriv', 'oanda'], default: 'internal' };

const brokerConfigSchema = new Schema(
  {
    key: { type: String, default: 'brokers', unique: true },
    routes: { crypto: route, forex: route, metals: route },
    deriv: {
      appId: String,
      /** Deriv account_id the platform routes to (current API: one session per account). */
      accountId: String,
      tokenEnc: String,
      currency: { type: String, default: 'USD' },
      multipliers: { crypto: { type: Number, default: 50 }, forex: { type: Number, default: 50 }, metals: { type: Number, default: 50 } },
      lastTest: Schema.Types.Mixed,
    },
    /** OANDA trading uses the OANDA credentials from Integrations. */
    oanda: { lastTest: Schema.Types.Mixed },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const BrokerConfigModel = model('BrokerConfig', brokerConfigSchema);
export type BrokerConfigDoc = InstanceType<typeof BrokerConfigModel>;
