/**
 * WhatsApp Cloud API Messaging Provider
 * 
 * Direct Meta Cloud API integration - replaces WATI
 * Adapted from microlearn-main/src/services/whatsappService.ts
 */

// ── Pre-approved Twilio Content SIDs (work outside the 24hr session window) ──
export const TWILIO_TEMPLATES = {
  daily_reminder:       'HX3097cf97f11eae20a76ee987c9bf0cff',  // vars: {1: name, 2: day, 3: course}
  course_complete:      'HXf0db8c84b5e931318c0519d8fd86c90f',  // quick-reply buttons
  student_registration: 'HXf882e3f42af1389ad24d9905ff509238',  // flow/form
  course_feedback:      'HX7fe79d524e43344bbb94918a1d133179',  // vars: {1: course_name}
  course_feedback_v2:   'HXc0b170a47c6da5de5756b288e502b2a9',  // updated version
} as const;

export type TwilioTemplateName = keyof typeof TWILIO_TEMPLATES;

export interface MessagingConfig {
  provider: 'cloudapi' | 'wati' | 'twilio' | 'mock';
  phoneNumberId: string;
  accessToken: string;
  businessAccountId?: string;
  appSecret?: string;
  apiVersion?: string;
  watiApiKey?: string;
  watiBaseUrl?: string;
  // Twilio-specific
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string; // e.g. '+17759930723'
  /** URL Twilio will POST status callbacks to (delivered, read, failed, etc.) */
  statusCallbackUrl?: string;
}

export interface TextMessage {
  text: string;
  previewUrl?: boolean;
}

export interface ImageMessage {
  imageUrl: string;
  caption?: string;
}

export interface VideoMessage {
  videoUrl: string;
  caption?: string;
}

export interface AudioMessage {
  audioUrl?: string;
  audioBase64?: string;
}

export interface DocumentMessage {
  documentUrl: string;
  filename: string;
  caption?: string;
}

export interface InteractiveButton {
  id: string;
  title: string;
}

export interface InteractiveButtonsMessage {
  header?: {
    type: 'text' | 'image' | 'video' | 'document';
    text?: string;
    imageUrl?: string;
    videoUrl?: string;
    documentUrl?: string;
  };
  body: string;
  footer?: string;
  buttons: InteractiveButton[];
}

export interface InteractiveListSection {
  title: string;
  rows: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
}

export interface InteractiveListMessage {
  header?: string;
  body: string;
  footer?: string;
  buttonText: string;
  sections: InteractiveListSection[];
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

class CloudAPIProvider {
  private config: MessagingConfig;
  private baseUrl: string;

  constructor(config: MessagingConfig) {
    this.config = config;
    const version = config.apiVersion || 'v18.0';
    this.baseUrl = `https://graph.facebook.com/${version}/${config.phoneNumberId}`;
  }

  private async request(endpoint: string, body: any): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json() as any;
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'WhatsApp API error');
    }

    return data;
  }

  async sendText(to: string, message: TextMessage): Promise<SendResult> {
    try {
      const result = await this.request('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'text',
        text: {
          body: message.text,
          preview_url: message.previewUrl
        }
      });

      return {
        success: true,
        messageId: result.messages?.[0]?.id
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendImage(to: string, message: ImageMessage): Promise<SendResult> {
    try {
      const result = await this.request('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'image',
        image: {
          link: message.imageUrl,
          caption: message.caption
        }
      });

      return {
        success: true,
        messageId: result.messages?.[0]?.id
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendVideo(to: string, message: VideoMessage): Promise<SendResult> {
    try {
      const result = await this.request('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'video',
        video: {
          link: message.videoUrl,
          caption: message.caption
        }
      });

      return {
        success: true,
        messageId: result.messages?.[0]?.id
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendAudio(to: string, audioBase64: string): Promise<SendResult> {
    try {
      // First upload the audio
      const uploadResult = await this.uploadMedia(audioBase64, 'audio/ogg');
      
      const result = await this.request('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'audio',
        audio: {
          id: uploadResult.id
        }
      });

      return {
        success: true,
        messageId: result.messages?.[0]?.id
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendDocument(to: string, message: DocumentMessage): Promise<SendResult> {
    try {
      const result = await this.request('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'document',
        document: {
          link: message.documentUrl,
          filename: message.filename,
          caption: message.caption
        }
      });

      return {
        success: true,
        messageId: result.messages?.[0]?.id
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendInteractiveButtons(to: string, message: InteractiveButtonsMessage): Promise<SendResult> {
    try {
      const interactive: any = {
        type: 'button',
        body: { text: message.body },
        action: {
          buttons: message.buttons.map((btn, idx) => ({
            type: 'reply',
            reply: {
              id: btn.id,
              title: btn.title.substring(0, 20) // Max 20 chars
            }
          }))
        }
      };

      if (message.header) {
        interactive.header = { type: message.header.type };
        if (message.header.type === 'text') {
          interactive.header.text = message.header.text;
        } else if (message.header.type === 'image') {
          interactive.header.image = { link: message.header.imageUrl };
        }
      }

      if (message.footer) {
        interactive.footer = { text: message.footer };
      }

      const result = await this.request('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive
      });

      return {
        success: true,
        messageId: result.messages?.[0]?.id
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendInteractiveList(to: string, message: InteractiveListMessage): Promise<SendResult> {
    try {
      const interactive: any = {
        type: 'list',
        body: { text: message.body },
        action: {
          button: message.buttonText.substring(0, 20),
          sections: message.sections.map(section => ({
            title: section.title.substring(0, 24),
            rows: section.rows.map(row => ({
              id: row.id,
              title: row.title.substring(0, 24),
              description: row.description?.substring(0, 72)
            }))
          }))
        }
      };

      if (message.header) {
        interactive.header = { type: 'text', text: message.header };
      }

      if (message.footer) {
        interactive.footer = { text: message.footer };
      }

      const result = await this.request('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.formatPhoneNumber(to),
        type: 'interactive',
        interactive
      });

      return {
        success: true,
        messageId: result.messages?.[0]?.id
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async downloadMedia(mediaId: string): Promise<Buffer> {
    // Get media URL
    const mediaResponse = await fetch(
      `https://graph.facebook.com/${this.config.apiVersion || 'v18.0'}/${mediaId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`
        }
      }
    );
    const mediaData = await mediaResponse.json() as any;
    
    // Download the actual file
    const fileResponse = await fetch(mediaData.url, {
      headers: {
        'Authorization': `Bearer ${this.config.accessToken}`
      }
    });
    
    const arrayBuffer = await fileResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async uploadMedia(base64Data: string, mimeType: string): Promise<{ id: string }> {
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: mimeType });
    
    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('type', mimeType);
    formData.append('messaging_product', 'whatsapp');

    const response = await fetch(
      `https://graph.facebook.com/${this.config.apiVersion || 'v18.0'}/${this.config.phoneNumberId}/media`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`
        },
        body: formData
      }
    );

    return await response.json() as { id: string };
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(
        `https://graph.facebook.com/${this.config.apiVersion || 'v18.0'}/${this.config.phoneNumberId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private formatPhoneNumber(phone: string): string {
    // Ensure phone has country code, no + prefix
    let formatted = phone.replace(/\D/g, '');
    if (!formatted.startsWith('91') && formatted.length === 10) {
      formatted = '91' + formatted;
    }
    return formatted;
  }
}

// WATI provider for backward compatibility
class WATIProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: MessagingConfig) {
    this.apiKey = config.watiApiKey || '';
    this.baseUrl = config.watiBaseUrl || 'https://live-server-9234.wati.io/api/v1';
  }

  private async request(endpoint: string, body: any): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    return await response.json();
  }

  async sendText(to: string, message: TextMessage): Promise<SendResult> {
    try {
      const result = await this.request('/sendSessionMessage/' + to, {
        messageText: message.text
      });
      return { success: true, messageId: result.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendImage(to: string, message: ImageMessage): Promise<SendResult> {
    try {
      const result = await this.request('/sendSessionFile/' + to, {
        url: message.imageUrl,
        caption: message.caption
      });
      return { success: true, messageId: result.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendInteractiveButtons(to: string, message: InteractiveButtonsMessage): Promise<SendResult> {
    try {
      const result = await this.request('/sendInteractiveButtonsMessage', {
        whatsappNumber: to,
        body: message.body,
        buttons: message.buttons.map(b => ({ text: b.title }))
      });
      return { success: true, messageId: result.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendInteractiveList(to: string, message: InteractiveListMessage): Promise<SendResult> {
    try {
      const result = await this.request('/sendInteractiveListMessage', {
        whatsappNumber: to,
        body: message.body,
        buttonText: message.buttonText,
        sections: message.sections
      });
      return { success: true, messageId: result.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // Stub methods for WATI
  async sendVideo(): Promise<SendResult> {
    return { success: false, error: 'Not supported in WATI mode' };
  }
  async sendAudio(): Promise<SendResult> {
    return { success: false, error: 'Not supported in WATI mode' };
  }
  async sendDocument(): Promise<SendResult> {
    return { success: false, error: 'Not supported in WATI mode' };
  }
  async downloadMedia(): Promise<Buffer> {
    throw new Error('Not supported in WATI mode');
  }
  async checkHealth(): Promise<boolean> {
    return true;
  }
}

// ─────────────────────────────────────────────
// Twilio WhatsApp provider
// ─────────────────────────────────────────────

// In-memory cache: sorted button titles → Content SID
// Avoids creating a new template on every message (matches original WhatsApp project behaviour)
const _quickReplyCache = new Map<string, string>();

class TwilioProvider {
  private accountSid: string;
  private authToken: string;
  private from: string; // 'whatsapp:+17759930723'
  private baseUrl: string;
  private statusCallbackUrl?: string;

  constructor(config: MessagingConfig) {
    this.accountSid = config.twilioAccountSid!;
    this.authToken = config.twilioAuthToken!;
    const raw = config.twilioFromNumber || '';
    this.from = raw.startsWith('whatsapp:') ? raw : `whatsapp:${raw}`;
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    this.statusCallbackUrl = config.statusCallbackUrl;
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
  }

  private formatTo(phone: string): string {
    const clean = phone.replace(/\D/g, '');
    const e164 = clean.startsWith('+') ? clean : `+${clean}`;
    return `whatsapp:${e164}`;
  }

  private async send(to: string, body: string): Promise<SendResult> {
    try {
      const params = new URLSearchParams({
        From: this.from,
        To: this.formatTo(to),
        Body: body,
      });
      if (this.statusCallbackUrl) {
        params.set('StatusCallback', this.statusCallbackUrl);
      }
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const data = await res.json() as any;
      if (!res.ok) return { success: false, error: data.message || 'Twilio error' };
      return { success: true, messageId: data.sid };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async sendText(to: string, message: TextMessage): Promise<SendResult> {
    return this.send(to, message.text);
  }

  async sendImage(to: string, message: ImageMessage): Promise<SendResult> {
    const body = message.caption ? `${message.caption}\n${message.imageUrl}` : message.imageUrl;
    return this.send(to, body);
  }

  async sendVideo(to: string, message: VideoMessage): Promise<SendResult> {
    const body = message.caption ? `${message.caption}\n${message.videoUrl}` : message.videoUrl;
    return this.send(to, body);
  }

  async sendAudio(_to: string, _b64: string): Promise<SendResult> {
    return { success: false, error: 'Audio not supported in Twilio text mode' };
  }

  async sendDocument(to: string, message: DocumentMessage): Promise<SendResult> {
    const body = message.caption ? `${message.caption}\n${message.documentUrl}` : message.documentUrl;
    return this.send(to, body);
  }

  /**
   * Interactive buttons via Twilio Content API (twilio/quick-reply).
   * Renders as real tappable WhatsApp buttons (max 3, 20 chars each).
   * When tapped, Twilio sends the button title as Body in the webhook.
   * Falls back to a numbered text list if Content API is unavailable.
   */
  async sendInteractiveButtons(to: string, message: InteractiveButtonsMessage): Promise<SendResult> {
    try {
      const actions = message.buttons.slice(0, 3).map(btn => ({
        type: 'QUICK_REPLY',
        title: btn.title.substring(0, 20),
        id: btn.id,
      }));

      // Cache key: body prefix + sorted button titles (matches original ekatra-whatsapp caching)
      const cacheKey = message.body.substring(0, 40) + '|' + message.buttons.map(b => b.title).sort().join('|');
      let sid = _quickReplyCache.get(cacheKey);

      if (!sid) {
        // Create a quick-reply Content template — include both twilio/text (required fallback)
        // AND twilio/quick-reply. language is required by the Content API.
        const contentRes = await fetch('https://content.twilio.com/v1/Content', {
          method: 'POST',
          headers: {
            Authorization: this.authHeader(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            friendly_name: `ek_${actions.map(a => a.id).join('_')}_${Date.now()}`,
            language: 'en',
            types: {
              'twilio/text': { body: message.body },
              'twilio/quick-reply': { body: message.body, actions },
            },
          }),
        });

        if (!contentRes.ok) {
          const errBody = await contentRes.text().catch(() => '');
          throw new Error(`Content API ${contentRes.status}: ${errBody}`);
        }
        const data = await contentRes.json() as { sid: string };
        sid = data.sid;
        _quickReplyCache.set(cacheKey, sid);
        if (_onCachePersist) _onCachePersist(cacheKey, sid);
      }

      // Send with ContentSid — renders as real WhatsApp buttons
      const params = new URLSearchParams({
        From: this.from,
        To: this.formatTo(to),
        ContentSid: sid,
      });
      if (this.statusCallbackUrl) {
        params.set('StatusCallback', this.statusCallbackUrl);
      }
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const data = await res.json() as any;
      if (!res.ok) return { success: false, error: data.message || 'Twilio error' };
      return { success: true, messageId: data.sid };
    } catch (err) {
      // Fallback: numbered text list (works in any WhatsApp session)
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Messaging] sendInteractiveButtons fallback (${errMsg})`);
      const lines = [message.body, ''];
      message.buttons.forEach((btn, i) => lines.push(`${i + 1}. ${btn.title}`));
      if (message.footer) lines.push('', `_${message.footer}_`);
      lines.push('', '_Reply with the number to continue_');
      return this.send(to, lines.join('\n'));
    }
  }

  async sendInteractiveList(to: string, message: InteractiveListMessage): Promise<SendResult> {
    const lines = [message.body, ''];
    let idx = 1;
    for (const section of message.sections) {
      if (section.title) lines.push(`*${section.title}*`);
      for (const row of section.rows) {
        lines.push(`${idx++}. ${row.title}${row.description ? ` — ${row.description}` : ''}`);
      }
    }
    return this.send(to, lines.join('\n'));
  }

  /**
   * Send a pre-approved Twilio Content template by SID.
   * Works outside the 24-hour session window — use for reminders & re-engagement.
   * @param to   Recipient phone number
   * @param sid  Twilio Content SID (HX...)
   * @param vars Template variable substitutions, e.g. { '1': 'Alice', '2': '3' }
   */
  async sendTemplate(
    to: string,
    sid: string,
    vars: Record<string, string> = {},
  ): Promise<SendResult> {
    try {
      const params = new URLSearchParams({
        From: this.from,
        To: this.formatTo(to),
        ContentSid: sid,
      });
      if (Object.keys(vars).length > 0) {
        params.set('ContentVariables', JSON.stringify(vars));
      }
      if (this.statusCallbackUrl) {
        params.set('StatusCallback', this.statusCallbackUrl);
      }
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const data = await res.json() as any;
      if (!res.ok) return { success: false, error: data.message || 'Twilio template error' };
      return { success: true, messageId: data.sid };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async downloadMedia(_id: string): Promise<Buffer> {
    throw new Error('Use media URL directly from Twilio webhook');
  }

  async checkHealth(): Promise<boolean> {
    return !!(this.accountSid && this.authToken);
  }
}

// Mock provider for low-cost local/web end-to-end testing.
class MockProvider {
  constructor(_config: MessagingConfig) {}

  async sendText(_to: string, _message: TextMessage): Promise<SendResult> {
    return { success: true, messageId: `mock_${Date.now()}` };
  }

  async sendImage(_to: string, _message: ImageMessage): Promise<SendResult> {
    return { success: true, messageId: `mock_${Date.now()}` };
  }

  async sendVideo(_to: string, _message: VideoMessage): Promise<SendResult> {
    return { success: true, messageId: `mock_${Date.now()}` };
  }

  async sendAudio(_to: string, _audioBase64: string): Promise<SendResult> {
    return { success: true, messageId: `mock_${Date.now()}` };
  }

  async sendDocument(_to: string, _message: DocumentMessage): Promise<SendResult> {
    return { success: true, messageId: `mock_${Date.now()}` };
  }

  async sendInteractiveButtons(_to: string, _message: InteractiveButtonsMessage): Promise<SendResult> {
    return { success: true, messageId: `mock_${Date.now()}` };
  }

  async sendInteractiveList(_to: string, _message: InteractiveListMessage): Promise<SendResult> {
    return { success: true, messageId: `mock_${Date.now()}` };
  }

  async downloadMedia(_mediaId: string): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  checkHealth() {
    return { ok: true, provider: 'mock' };
  }
}

// ─────────────────────────────────────────────
// Message lifecycle callback
// ─────────────────────────────────────────────

export interface MessageSentEvent {
  to: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'interactive_buttons' | 'interactive_list' | 'template';
  /** Truncated preview of the content sent */
  content: string;
  result: SendResult;
}

export type MessageSentCallback = (event: MessageSentEvent) => Promise<void>;

let _onMessageSent: MessageSentCallback | undefined;

/**
 * Register a callback invoked after every outbound send attempt (success or failure).
 * Use this in the backend to persist outbound messages to message_log.
 */
export function registerMessageSentCallback(cb: MessageSentCallback): void {
  _onMessageSent = cb;
}

// Content API cache persistence
let _onCachePersist: ((key: string, sid: string) => void) | undefined;

export function registerCachePersistCallback(fn: (key: string, sid: string) => void): void {
  _onCachePersist = fn;
}

export function preloadQuickReplyCache(entries: Map<string, string>): void {
  for (const [k, v] of entries) {
    _quickReplyCache.set(k, v);
  }
}

async function emitSent(event: MessageSentEvent): Promise<void> {
  if (_onMessageSent) {
    try {
      await _onMessageSent(event);
    } catch {
      // Never let logging errors propagate to callers
    }
  }
}

class TelegramProvider {
  private baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  // Telegram chat ids arrive as "tg:<chat_id>" from the gateway
  private chatId(to: string): string {
    return to.startsWith('tg:') ? to.slice(3) : to;
  }

  private async call(method: string, payload: Record<string, any>): Promise<SendResult> {
    try {
      const response = await fetch(`${this.baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data: any = await response.json();
      if (!data.ok) return { success: false, error: data.description || `Telegram ${method} failed` };
      return { success: true, messageId: `tg_${data.result?.message_id ?? Date.now()}` };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // WhatsApp-style *bold* happens to match Telegram's legacy Markdown; retry plain on parse errors
  private async sendWithMarkdownFallback(payload: Record<string, any>): Promise<SendResult> {
    const result = await this.call('sendMessage', { ...payload, parse_mode: 'Markdown' });
    if (!result.success && /parse/i.test(result.error || '')) {
      return this.call('sendMessage', payload);
    }
    return result;
  }

  async sendText(to: string, message: TextMessage): Promise<SendResult> {
    return this.sendWithMarkdownFallback({ chat_id: this.chatId(to), text: message.text });
  }

  async sendImage(to: string, message: ImageMessage): Promise<SendResult> {
    return this.call('sendPhoto', { chat_id: this.chatId(to), photo: message.imageUrl, caption: message.caption });
  }

  async sendVideo(to: string, message: VideoMessage): Promise<SendResult> {
    return this.call('sendVideo', { chat_id: this.chatId(to), video: message.videoUrl, caption: message.caption });
  }

  async sendAudio(_to: string, _audioBase64: string): Promise<SendResult> {
    return { success: false, error: 'base64 audio not supported for Telegram provider' };
  }

  async sendDocument(to: string, message: DocumentMessage): Promise<SendResult> {
    return this.call('sendDocument', { chat_id: this.chatId(to), document: message.documentUrl, caption: message.caption });
  }

  async sendInteractiveButtons(to: string, message: InteractiveButtonsMessage): Promise<SendResult> {
    const text = [message.header?.text, message.body, message.footer].filter(Boolean).join('\n\n');
    return this.sendWithMarkdownFallback({
      chat_id: this.chatId(to),
      text,
      reply_markup: {
        inline_keyboard: message.buttons.map((b) => [{ text: b.title, callback_data: b.id }]),
      },
    });
  }

  async sendInteractiveList(to: string, message: InteractiveListMessage): Promise<SendResult> {
    const text = [message.header, message.body, message.footer].filter(Boolean).join('\n\n');
    const rows = message.sections.flatMap((s) => s.rows.map((r) => [{ text: r.title, callback_data: r.id }]));
    return this.sendWithMarkdownFallback({ chat_id: this.chatId(to), text, reply_markup: { inline_keyboard: rows } });
  }

  async downloadMedia(_mediaId: string): Promise<Buffer> {
    throw new Error('downloadMedia not supported for Telegram provider');
  }

  // Multipart upload for generated media (buffers have no public URL)
  private async upload(method: string, field: string, to: string, buffer: Buffer, filename: string, extra: Record<string, string>): Promise<SendResult> {
    try {
      const form = new FormData();
      form.append('chat_id', this.chatId(to));
      form.append(field, new Blob([new Uint8Array(buffer)]), filename);
      for (const [k, v] of Object.entries(extra)) if (v) form.append(k, v);
      const response = await fetch(`${this.baseUrl}/${method}`, { method: 'POST', body: form });
      const data: any = await response.json();
      if (!data.ok) return { success: false, error: data.description || `Telegram ${method} failed` };
      return { success: true, messageId: `tg_${data.result?.message_id ?? Date.now()}` };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendImageBuffer(to: string, buffer: Buffer, caption?: string): Promise<SendResult> {
    return this.upload('sendPhoto', 'photo', to, buffer, 'image.png', { caption: caption || '' });
  }

  async sendVoiceBuffer(to: string, buffer: Buffer, caption?: string): Promise<SendResult> {
    return this.upload('sendVoice', 'voice', to, buffer, 'voice.mp3', { caption: caption || '' });
  }

  async sendVideoBuffer(to: string, buffer: Buffer, caption?: string): Promise<SendResult> {
    return this.upload('sendVideo', 'video', to, buffer, 'video.mp4', { caption: caption || '' });
  }

  async checkHealth() {
    const result = await this.call('getMe', {});
    return { ok: result.success, provider: 'telegram' };
  }
}

// ─────────────────────────────────────────────
// Factory and singleton
// ─────────────────────────────────────────────
let messagingInstance: CloudAPIProvider | WATIProvider | TwilioProvider | MockProvider | null = null;

// Secondary channel: learners addressed as "tg:<chat_id>" route here instead of the primary provider
let telegramInstance: TelegramProvider | null = null;

export function initializeTelegram(botToken: string): void {
  telegramInstance = new TelegramProvider(botToken);
}

export function isTelegramRecipient(to: string): boolean {
  return to.startsWith('tg:');
}

function providerFor(to: string): CloudAPIProvider | WATIProvider | TwilioProvider | MockProvider | TelegramProvider {
  if (!messagingInstance) throw new Error('Messaging not initialized');
  if (isTelegramRecipient(to)) {
    if (!telegramInstance) throw new Error('Telegram not initialized — set TELEGRAM_BOT_TOKEN');
    return telegramInstance;
  }
  return messagingInstance;
}

export function initializeMessaging(config: MessagingConfig): void {
  if (config.provider === 'mock') {
    messagingInstance = new MockProvider(config);
  } else if (config.provider === 'twilio') {
    messagingInstance = new TwilioProvider(config);
  } else if (config.provider === 'wati') {
    messagingInstance = new WATIProvider(config);
  } else {
    messagingInstance = new CloudAPIProvider(config);
  }
}

export const messaging = {
  async sendText(to: string, message: TextMessage): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    const result = await providerFor(to).sendText(to, message);
    await emitSent({ to, type: 'text', content: message.text.substring(0, 200), result });
    return result;
  },
  async sendImage(to: string, message: ImageMessage): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    const result = await providerFor(to).sendImage(to, message);
    await emitSent({ to, type: 'image', content: message.caption || message.imageUrl, result });
    return result;
  },
  async sendVideo(to: string, message: VideoMessage): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    const result = await (providerFor(to) as CloudAPIProvider).sendVideo(to, message);
    await emitSent({ to, type: 'video', content: message.caption || message.videoUrl, result });
    return result;
  },
  async sendAudio(to: string, audioBase64: string): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    const result = await (providerFor(to) as CloudAPIProvider).sendAudio(to, audioBase64);
    await emitSent({ to, type: 'audio', content: '[audio]', result });
    return result;
  },
  async sendDocument(to: string, message: DocumentMessage): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    const result = await (providerFor(to) as CloudAPIProvider).sendDocument(to, message);
    await emitSent({ to, type: 'document', content: message.filename || message.documentUrl, result });
    return result;
  },
  async sendInteractiveButtons(to: string, message: InteractiveButtonsMessage): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    const result = await providerFor(to).sendInteractiveButtons(to, message);
    const btnLabels = message.buttons.map(b => b.title).join(' | ');
    await emitSent({ to, type: 'interactive_buttons', content: `${message.body.substring(0, 100)} [${btnLabels}]`, result });
    return result;
  },
  async sendInteractiveList(to: string, message: InteractiveListMessage): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    const result = await providerFor(to).sendInteractiveList(to, message);
    await emitSent({ to, type: 'interactive_list', content: message.body.substring(0, 100), result });
    return result;
  },
  /** Send generated media from a Buffer. Telegram recipients only for now (WhatsApp needs the media-upload API). */
  async sendImageBuffer(to: string, buffer: Buffer, caption?: string): Promise<SendResult> {
    const provider = providerFor(to);
    const result = provider instanceof TelegramProvider
      ? await provider.sendImageBuffer(to, buffer, caption)
      : { success: false, error: 'sendImageBuffer only supported for Telegram recipients' };
    await emitSent({ to, type: 'image', content: caption || '[generated image]', result });
    return result;
  },
  async sendVoiceBuffer(to: string, buffer: Buffer, caption?: string): Promise<SendResult> {
    const provider = providerFor(to);
    const result = provider instanceof TelegramProvider
      ? await provider.sendVoiceBuffer(to, buffer, caption)
      : { success: false, error: 'sendVoiceBuffer only supported for Telegram recipients' };
    await emitSent({ to, type: 'audio', content: caption || '[generated audio]', result });
    return result;
  },
  async sendVideoBuffer(to: string, buffer: Buffer, caption?: string): Promise<SendResult> {
    const provider = providerFor(to);
    const result = provider instanceof TelegramProvider
      ? await provider.sendVideoBuffer(to, buffer, caption)
      : { success: false, error: 'sendVideoBuffer only supported for Telegram recipients' };
    await emitSent({ to, type: 'video', content: caption || '[generated video]', result });
    return result;
  },
  downloadMedia: (mediaId: string) => {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    return (messagingInstance as CloudAPIProvider).downloadMedia(mediaId);
  },
  checkHealth: () => {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    return messagingInstance.checkHealth();
  },
  /**
   * Send a pre-approved Twilio template (HX SID) — works outside the 24hr session window.
   * Falls back to a plain text sendText() if the provider is not Twilio.
   */
  async sendTemplate(to: string, sid: string, vars: Record<string, string> = {}): Promise<SendResult> {
    if (!messagingInstance) throw new Error('Messaging not initialized');
    let result: SendResult;
    if (messagingInstance instanceof TwilioProvider) {
      result = await messagingInstance.sendTemplate(to, sid, vars);
    } else {
      // Non-Twilio providers: log and no-op (template re-engagement not supported)
      result = { success: false, error: 'sendTemplate only supported for Twilio provider' };
    }
    await emitSent({ to, type: 'template', content: `[template:${sid}]`, result });
    return result;
  },
};

export default messaging;
