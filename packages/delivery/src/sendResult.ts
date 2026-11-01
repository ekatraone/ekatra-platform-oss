import type { SendResult } from '@ekatra/messaging';

/** Providers can report failure without rejecting their promise. */
export async function checkedSend(operation: Promise<SendResult>): Promise<SendResult> {
  const result = await operation;
  // A permanent skip (recipient has no channel, e.g. an app-only learner) is not a failure:
  // throwing would send it down the retry / dead-letter paths for a message that can never go out.
  if (!result.success && !result.permanent) throw new Error('Messaging provider rejected delivery');
  return result;
}
