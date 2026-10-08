import { Schema, model } from 'mongoose';

/**
 * Single-use email tokens: verification links and 6-digit second-factor codes.
 * Only an HMAC of the token is stored; documents expire automatically (TTL index).
 */
export const EMAIL_TOKEN_PURPOSES = ['VERIFY_EMAIL', 'LOGIN_2FA', 'ACTION_2FA'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

const emailTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: EMAIL_TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date },
  },
  { timestamps: true },
);
emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
emailTokenSchema.index({ user: 1, purpose: 1, createdAt: -1 });

export const EmailTokenModel = model('EmailToken', emailTokenSchema);
