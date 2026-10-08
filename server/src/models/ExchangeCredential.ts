import { Schema, model, Types } from 'mongoose';

/**
 * Exchange API credentials. Key and secret are encrypted with AES-256-GCM and never
 * selected by default. They are never returned to the browser - only masked hints are.
 */
const exchangeCredentialSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    exchange: { type: String, required: true, lowercase: true },
    label: { type: String, default: 'default' },
    encryptedKey: { type: String, required: true, select: false },
    encryptedSecret: { type: String, required: true, select: false },
    encryptedPassphrase: { type: String, select: false },
    keyHint: String, // last 4 chars only
    testnet: { type: Boolean, default: true },
    permissions: {
      verifiedAt: Date,
      canTrade: Boolean,
      canWithdraw: Boolean,
      raw: Schema.Types.Mixed,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
exchangeCredentialSchema.index({ user: 1, exchange: 1, label: 1 }, { unique: true });
exchangeCredentialSchema.set('toJSON', {
  transform: (_d, ret: Record<string, unknown>) => {
    delete ret.encryptedKey;
    delete ret.encryptedSecret;
    delete ret.encryptedPassphrase;
    delete ret.__v;
    return ret;
  },
});

export const ExchangeCredential = model('ExchangeCredential', exchangeCredentialSchema);
