import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | null = null;

/**
 * Connect to a throwaway MongoDB. Uses MONGODB_TEST_URI if provided (e.g. a CI service container),
 * otherwise starts mongodb-memory-server (set MONGOMS_SYSTEM_BINARY to use a local mongod).
 */
export async function connectTestDb() {
  let uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    mongod = await MongoMemoryServer.create();
    uri = mongod.getUri();
  }
  const dbName = `afeyfx_test_${process.pid}_${Date.now()}`;
  await mongoose.connect(uri, { dbName });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function clearDb() {
  const cols = await mongoose.connection.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

export async function disconnectTestDb() {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = null;
}
