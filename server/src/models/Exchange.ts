import { Schema, model } from 'mongoose';

const exchangeSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, lowercase: true }, // binance | bybit | coinbase
    displayName: String,
    enabled: { type: Boolean, default: true },
    testnet: { type: Boolean, default: true },
    status: { type: String, enum: ['CONNECTED', 'DEGRADED', 'DISCONNECTED', 'UNKNOWN'], default: 'UNKNOWN' },
    lastHeartbeatAt: Date,
    lastError: String,
    takerFee: { type: Number, default: 0.001 },
    makerFee: { type: Number, default: 0.001 },
  },
  { timestamps: true },
);

export const Exchange = model('Exchange', exchangeSchema);
