// Starts the test fixture site on a free port and keeps it running until interrupted.
// Usage: node --import tsx scripts/fixture-site.mts
import { startFixtureSite } from '../test/fixtures/server.ts';

const site = await startFixtureSite();
console.log(`fixture site: ${site.baseUrl}`);
const stop = async () => {
  await site.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
await new Promise(() => {});
