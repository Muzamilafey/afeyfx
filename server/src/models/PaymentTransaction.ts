import { Schema, model } from 'mongoose';

/**
 * Real-money cash movements on a trader's REAL account. Amounts are stored as integers
 * (USD cents, whole Kenyan shillings) so rounding can never create or destroy money.
 *
 * Deposit lifecycle:  PENDING (STK push sent, waiting for the customer's PIN)
 *                       -> COMPLETED (confirmed with M-Pesa, account credited once)
 *                       -> FAILED (cancelled / timed out / declined)
 *                       -> UNCERTAIN (amount mismatch or unconfirmable; an admin decides)
 * Payout lifecycle:   PENDING (funds held, waiting for admin approval)
 *                       -> PROCESSING (B2C request accepted by M-Pesa)
 *                       -> COMPLETED | FAILED (held funds refunded)
 *                       -> REJECTED by admin / CANCELLED by trader (held funds refunded)
 *                       -> UNCERTAIN (no definitive result; NEVER auto-refunded, an admin decides)
 */
export const PAYMENT_TYPES = ['DEPOSIT', 'PAYOUT'] as const;
export const PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED', 'UNCERTAIN'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const paymentSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Public numeric transaction id shown to the trader. */
    reference: { type: String, required: true, unique: true },
    type: { type: String, enum: PAYMENT_TYPES, required: true, index: true },
    method: { type: String, enum: ['MPESA'], default: 'MPESA' },
    provider: { type: String, enum: ['daraja', 'simulated'], default: 'daraja' },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING', index: true },
    idempotencyKey: { type: String, required: true },
    /** Amount the trader asked for (deposit credit / payout debit), in USD cents. */
    amountCents: { type: Number, required: true },
    /** Payout fee in USD cents (deducted from the amount sent). */
    feeCents: { type: Number, default: 0 },
    /** Shillings charged (deposit) or sent (payout). */
    amountKes: { type: Number, required: true },
    /** KES per USD used for this transaction. */
    rate: { type: Number, required: true },
    phone: { type: String, required: true },
    firstName: String,
    lastName: String,
    // Provider references
    merchantRequestId: String,
    checkoutRequestId: { type: String, index: { unique: true, sparse: true } },
    originatorConversationId: { type: String, index: { unique: true, sparse: true } },
    conversationId: String,
    receipt: { type: String, index: { unique: true, sparse: true } },
    resultCode: String,
    resultDesc: String,
    /** Sanitized provider responses and callbacks (no credentials). */
    events: { type: [Schema.Types.Mixed], default: [] },
    /** Money-movement flags; each flips exactly once (atomic conditional updates). */
    credited: { type: Boolean, default: false },
    held: { type: Boolean, default: false },
    refunded: { type: Boolean, default: false },
    /** Payouts: whether the destination phone was used for an earlier successful deposit. */
    knownDestination: Boolean,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: String,
    lastQueriedAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);
paymentSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ status: 1, type: 1, createdAt: 1 });

export const PaymentModel = model('PaymentTransaction', paymentSchema);
export type PaymentDoc = InstanceType<typeof PaymentModel>;
