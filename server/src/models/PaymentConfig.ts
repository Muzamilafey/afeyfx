import { Schema, model } from 'mongoose';

/**
 * Admin-managed M-Pesa (Safaricom Daraja) configuration. Singleton (key = 'mpesa').
 * Credentials are AES-256-GCM encrypted at rest (ENCRYPTION_KEY) and never sent to a browser.
 * Everything is OFF until an admin configures and enables it.
 */
const paymentConfigSchema = new Schema(
  {
    key: { type: String, default: 'mpesa', unique: true },
    depositsEnabled: { type: Boolean, default: false },
    payoutsEnabled: { type: Boolean, default: false },
    /** Trading with REAL-account money. Off by default; deposits/withdrawals work without it. */
    realTradingEnabled: { type: Boolean, default: false },
    /** sandbox / production = Safaricom Daraja; simulated = local test double (refused in production). */
    environment: { type: String, enum: ['sandbox', 'production', 'simulated'], default: 'sandbox' },

    // Daraja app credentials
    consumerKeyEnc: String,
    consumerSecretEnc: String,
    // STK Push (Lipa na M-Pesa Online) for deposits
    shortcode: String,
    passkeyEnc: String,
    transactionType: { type: String, enum: ['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'], default: 'CustomerPayBillOnline' },
    /** Till number for Buy Goods (PartyB). Defaults to the shortcode. */
    partyB: String,
    accountReference: { type: String, default: 'AfeyFX' },
    // B2C for payouts
    b2cShortcode: String,
    initiatorName: String,
    /** Initiator password encrypted with the Safaricom certificate (generate it in the Daraja portal). */
    securityCredentialEnc: String,
    b2cCommandId: { type: String, enum: ['BusinessPayment', 'SalaryPayment', 'PromotionPayment'], default: 'BusinessPayment' },

    /** Secret path segment of the callback URLs (Daraja callbacks are not signed). */
    callbackToken: String,
    /** Optional allow-list of Safaricom callback source IPs. Empty = token only. */
    callbackIps: { type: [String], default: [] },

    // Money rules (USD cents unless stated)
    depositRate: { type: Number, default: 130 }, // KES charged per USD credited
    payoutRate: { type: Number, default: 127 }, // KES sent per USD withdrawn
    minDepositCents: { type: Number, default: 1_000 },
    maxDepositCents: { type: Number, default: 100_000 },
    minPayoutCents: { type: Number, default: 1_000 },
    maxPayoutCents: { type: Number, default: 50_000 },
    dailyPayoutLimitCents: { type: Number, default: 100_000 },
    payoutFeePct: { type: Number, default: 0.03 },
    payoutFeeFixedCents: { type: Number, default: 0 },
    /** Payouts at or below this amount are sent without manual review. 0 = always review. */
    autoApproveBelowCents: { type: Number, default: 0 },
    /** Only pay out to phone numbers that made a successful deposit (anti-fraud). */
    payoutsToDepositPhonesOnly: { type: Boolean, default: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const PaymentConfigModel = model('PaymentConfig', paymentConfigSchema);
export type PaymentConfigDoc = InstanceType<typeof PaymentConfigModel>;
