export interface CloudApiReceiptEvent {
  externalEventId: string;
  eventType: 'message' | 'status';
  payload: Record<string, unknown>;
  context: {
    contacts?: unknown[];
    metadata?: Record<string, unknown>;
  };
}

/**
 * Convert a Meta Cloud API batch into independently idempotent events.
 * Events without a provider identifier are ignored because they cannot be
 * replayed safely without risking a duplicate learner state transition.
 */
export function extractCloudApiReceiptEvents(body: unknown): CloudApiReceiptEvent[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, any>;
  if (root.object !== 'whatsapp_business_account') return [];

  const events: CloudApiReceiptEvent[] = [];
  for (const entry of Array.isArray(root.entry) ? root.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages' || !change.value) continue;
      const value = change.value;
      const context = { contacts: value.contacts, metadata: value.metadata };

      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (typeof message?.id !== 'string' || !message.id) continue;
        events.push({ externalEventId: message.id, eventType: 'message', payload: message, context });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof status?.id !== 'string' || !status.id || typeof status?.status !== 'string') continue;
        const timestamp = typeof status.timestamp === 'string' ? status.timestamp : 'unknown';
        events.push({
          externalEventId: `${status.id}:${status.status}:${timestamp}`,
          eventType: 'status',
          payload: status,
          context,
        });
      }
    }
  }
  return events;
}

export interface CloudApiMessageHandler {
  handle(message: {
    from: string;
    name?: string;
    timestamp?: string;
    type?: string;
    text?: string;
    mediaId?: string;
    buttonPayload?: string;
    listReplyId?: string;
    buttonReplyId?: string;
  }, options?: { rethrow?: boolean }): Promise<unknown>;
}

/**
 * Meta puts delivery failure reasons in `status.errors` ({code, title, message,
 * error_data}); map the first one onto the same metadata keys the Twilio path uses.
 */
export function cloudApiStatusMetadata(status: any): Record<string, unknown> | undefined {
  const err = Array.isArray(status?.errors) ? status.errors[0] : undefined;
  if (!err || typeof err !== 'object') return undefined;
  const metadata: Record<string, unknown> = {};
  if (err.code !== undefined) metadata.error_code = err.code;
  const channelError = err.title || err.message;
  if (channelError) metadata.channel_error = channelError;
  if (err.error_data?.details) metadata.error_details = err.error_data.details;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Process one already-persisted receipt. Rejects when the event was not
 * actually handled (processing error, or the learner's lock was busy) so the
 * caller leaves the receipt retryable instead of marking it processed.
 */
export async function processCloudApiReceiptEvent(
  event: CloudApiReceiptEvent,
  messageHandler: CloudApiMessageHandler,
): Promise<void> {
  if (event.eventType === 'status') {
    const status = event.payload as any;
    const asNumber = typeof status.timestamp === 'string' ? Number.parseInt(status.timestamp, 10) : NaN;
    const timestamp = typeof status.timestamp !== 'string'
      ? new Date()
      : Number.isNaN(asNumber) ? new Date(status.timestamp) : new Date(asNumber * 1000);
    const { db } = await import('@ekatra/database');
    await db.messageLog.updateStatus(status.id, status.status, timestamp, cloudApiStatusMetadata(status));
    return;
  }

  const message = event.payload as any;
  const contact = event.context.contacts?.find((candidate: any) => candidate.wa_id === message.from) as any;
  await messageHandler.handle({
    from: message.from,
    name: contact?.profile?.name,
    timestamp: message.timestamp,
    type: message.type,
    text: message.text?.body,
    mediaId: message.image?.id || message.document?.id || message.audio?.id || message.video?.id,
    buttonPayload: message.button?.payload,
    listReplyId: message.interactive?.list_reply?.id,
    buttonReplyId: message.interactive?.button_reply?.id,
  }, { rethrow: true });
}
