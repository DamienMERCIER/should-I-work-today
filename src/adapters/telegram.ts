import { sleep as defaultSleep, type FetchLike } from './http';

/**
 * A button is either a callback (handled by the bot) or a url button (opened by the client) — never
 * both, never neither. The `?: never` on the opposite field is what actually enforces "never both":
 * a plain two-arm union accepts `{ text, callback_data, url }`, because excess-property checking on
 * an untagged union tests against the union of every arm's keys, so `url` does not read as excess.
 */
export type InlineButton =
  | { text: string; callback_data: string; url?: never }
  | { text: string; url: string; callback_data?: never };
export interface KeyboardButton { text: string; request_location?: boolean }
export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | { keyboard: KeyboardButton[][]; resize_keyboard: boolean; is_persistent: boolean };

export type SendResult =
  | { ok: true }
  | { ok: false; blocked: boolean; retryAfter?: number; description: string };

export interface TgUser { id: number; language_code?: string; first_name?: string }
export interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  location?: { latitude: number; longitude: number };
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgResponse { ok: boolean; description?: string; parameters?: { retry_after?: number }; result?: unknown }

export class Telegram {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  private async call(method: string, body: Record<string, unknown>): Promise<{ status: number; json: TgResponse }> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { status: 0, json: { ok: false, description: `network: ${String(err)}` } };
    }
    const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResponse;
    return { status: res.status, json };
  }

  /** HTML, sans aperçu de lien. 429 → attend `retry_after` et réessaie une fois ; 403 → `blocked` (§11). */
  async sendMessage(chatId: number, text: string, replyMarkup?: ReplyMarkup): Promise<SendResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    };
    if (replyMarkup) body.reply_markup = replyMarkup;

    let { status, json } = await this.call('sendMessage', body);
    if (status === 429) {
      await this.sleep((json.parameters?.retry_after ?? 1) * 1000);
      ({ status, json } = await this.call('sendMessage', body));
    }
    if (json.ok) return { ok: true };
    return {
      ok: false,
      blocked: status === 403,
      retryAfter: json.parameters?.retry_after,
      description: json.description ?? `HTTP ${status}`,
    };
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  async setWebhook(url: string, secretToken: string): Promise<TgResponse> {
    const { json } = await this.call('setWebhook', {
      url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
    });
    return json;
  }
}
