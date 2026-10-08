import mongoose from 'mongoose';
import { env } from './env';
import { logger, errorMessage } from '../utils/logger';
import { circuitBreaker } from '../risk/CircuitBreaker';

export async function connectDb(uri = env.MONGODB_URI) {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => {
    circuitBreaker.trip('DATABASE_UNAVAILABLE', 'MongoDB disconnected');
    logger.error('MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    circuitBreaker.recover('DATABASE_UNAVAILABLE');
    logger.info('MongoDB reconnected');
  });
  mongoose.connection.on('error', (err) => logger.error({ err: errorMessage(err) }, 'MongoDB error'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 20 });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes().catch((err) => logger.warn({ model: m.modelName, err: errorMessage(err) }, 'Index sync failed'))));
  logger.info('MongoDB connected');
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
