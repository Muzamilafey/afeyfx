import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Separate, opt-in Deriv authorization with the payments scope (funding only). Kept apart from
 * BrokerConnection so that trading code, the strategy engine and the bot can never read it.
 */
const derivFundingAuthSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    accessTokenEnc: { type: String, required: true },
    refreshTokenEnc: String,
    tokenType: { type: String, enum: ['oauth'], default: 'oauth' },
    tokenExpiresAt: Date,
    scopes: { type: [String], default: [] },
    lastUsedAt: Date,
  },
  { timestamps: true },
);
export const DerivFundingAuthModel = model('DerivFundingAuth', derivFundingAuthSchema);

/**
 * Funding history: Deriv deposits, withdrawals and transfers. Rows from Deriv's statement are
 * COMPLETED (booked by Deriv). Transfers started from AfeyFX are PENDING until the statement shows
 * Deriv's transaction id, UNKNOWN if the outcome could not be verified, FAILED if Deriv refused.
 */
const fundingTransactionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    connection: { type: Schema.Types.ObjectId, ref: 'BrokerConnection', index: true },
    provider: { type: String, default: 'deriv' },
    accountId: { type: String, required: true },
    type: { type: String, enum: ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT'], required: true },
    status: { type: String, enum: ['PENDING', 'COMPLETED', 'FAILED', 'UNKNOWN'], required: true, index: true },
    amount: { type: Number, required: true },
    currency: String,
    /** Deriv transaction id (provider reference). */
    reference: String,
    counterpartAccount: String,
    description: String,
    source: { type: String, enum: ['statement', 'afeyfx-transfer'], required: true },
    idempotencyKey: { type: String, unique: true, sparse: true },
    message: String,
    occurredAt: Date,
    verifiedAt: Date,
    lastCheckedAt: Date,
  },
  { timestamps: true },
);
fundingTransactionSchema.index({ provider: 1, accountId: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } });
export const FundingTransactionModel = model('FundingTransaction', fundingTransactionSchema);
export type FundingTransactionDoc = HydratedDocument<InferSchemaType<typeof fundingTransactionSchema>>;
