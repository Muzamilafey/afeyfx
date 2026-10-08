import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    /** Absent for accounts that only sign in with Google. */
    passwordHash: { type: String, select: false },
    passwordSet: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },
    /** Google account subject id ("Continue with Google"). */
    googleId: { type: String, unique: true, sparse: true },
    /** GitHub account id ("Continue with GitHub"). */
    githubId: { type: String, unique: true, sparse: true },
    avatarUrl: { type: String },
    role: { type: String, enum: ['admin', 'trader', 'viewer'], default: 'viewer', index: true },
    /** Authenticator-app (TOTP) second factor. */
    twoFactorEnabled: { type: Boolean, default: false },
    /** One-time codes sent by email as a second factor (requires a verified email). */
    emailOtpEnabled: { type: Boolean, default: false },
    /** Encrypted (AES-GCM) TOTP secret. */
    twoFactorSecret: { type: String, select: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

userSchema.set('toJSON', {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.passwordHash;
    delete ret.twoFactorSecret;
    delete ret.__v;
    return ret;
  },
});

/** True when the user has at least one second factor (authenticator app or email codes). */
export const hasSecondFactor = (u: { twoFactorEnabled?: boolean | null; emailOtpEnabled?: boolean | null }) => !!u.twoFactorEnabled || !!u.emailOtpEnabled;

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = model('User', userSchema);
