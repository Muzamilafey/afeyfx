/**
 * Create (or promote) an admin user from the command line.
 *   npm run create-admin -- admin@example.com "Admin Name"
 * The password is read from the ADMIN_PASSWORD env var or prompted for (never passed as an argument,
 * so it does not end up in shell history).
 */
import readline from 'readline';
import { connectDb, disconnectDb } from '../config/db';
import { User } from '../models/User';
import { AuthService, validatePasswordStrength } from '../services/AuthService';

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => (rl.close(), r(a))));
}

async function main() {
  const [email, name = 'Admin'] = process.argv.slice(2);
  if (!email) throw new Error('Usage: npm run create-admin -- <email> [name]');
  const password = process.env.ADMIN_PASSWORD || (await prompt('Password (min 12 chars, upper/lower/digit): '));
  validatePasswordStrength(password);
  await connectDb();
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    existing.role = 'admin';
    existing.passwordHash = await AuthService.hashPassword(password);
    await existing.save();
    console.log(`Updated ${email} -> admin`);
  } else {
    await User.create({ email, name, passwordHash: await AuthService.hashPassword(password), role: 'admin' });
    console.log(`Created admin ${email}. Enable 2FA from Settings before using protected actions.`);
  }
  await disconnectDb();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
