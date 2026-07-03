import { Context } from '#types/index.js';
import { fetchJson } from './fetch.js';
import { safeConsole } from './io.js';

export async function sendNotification(ctx: Context, message: string): Promise<void> {
  const { telegramBotToken, telegramChatId, discordWebhookUrl } = ctx.config;
  const promises: Promise<unknown>[] = [];

  if (telegramBotToken && telegramChatId) {
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    promises.push(
      fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { chat_id: telegramChatId, text: message, parse_mode: 'HTML' },
      }).catch((err: Error) =>
        safeConsole('error', `[NOTIFY ERROR] Telegram failed: ${err.message}`)
      )
    );
  }

  if (discordWebhookUrl) {
    promises.push(
      fetchJson(discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { content: message },
      }).catch((err: Error) =>
        safeConsole('error', `[NOTIFY ERROR] Discord failed: ${err.message}`)
      )
    );
  }

  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
}
