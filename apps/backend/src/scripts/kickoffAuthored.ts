/**
 * One-shot E2E kick-off for an authored course (M12 verification tool).
 * Simulates the learner's first inbound message through the real FSM engine,
 * causing the Day-1 chain to be delivered over the live channel (Telegram).
 * Subsequent button taps flow through the running backend's poller as normal.
 *
 * Usage: npx tsx src/scripts/kickoffAuthored.ts <learner-phone e.g. tg:12345> [text]
 */
import 'dotenv/config';

async function main() {
  const phone = process.argv[2];
  const text = process.argv[3] ?? 'hi';
  if (!phone) {
    console.error('Usage: kickoffAuthored.ts <learner-phone> [text]');
    process.exit(1);
  }

  const { initializeDatabase, db } = await import('@ekatra/database');
  const { initializeMessaging, initializeTelegram } = await import('@ekatra/messaging');

  initializeDatabase({ connectionString: process.env.DATABASE_URL });
  initializeMessaging({
    provider: 'cloudapi',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || 'local-dev',
    accessToken: process.env.META_ACCESS_TOKEN || 'local-dev-disabled',
  });
  if (process.env.TELEGRAM_BOT_TOKEN) initializeTelegram(process.env.TELEGRAM_BOT_TOKEN);

  const learner = await db.learners.findByPhone(phone);
  if (!learner) {
    console.error(`Learner not found: ${phone}`);
    process.exit(1);
  }

  const { conversationFSM } = await import('../flows/conversationFSM.js');
  await conversationFSM.process(learner, { from: phone, type: 'text', text });
  console.log('Kick-off message processed — check the learner chat.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
