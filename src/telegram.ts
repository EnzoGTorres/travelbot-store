import { config } from "./config";
import { requestJson } from "./http";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

interface SendTelegramMessageOptions {
  dryRun?: boolean;
}

function getTelegramConfig() {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    throw new Error(
      "Falta configuracion de Telegram. Revisa TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID."
    );
  }

  return {
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId
  };
}

export async function sendTelegramMessage(
  text: string,
  options?: SendTelegramMessageOptions
): Promise<void> {
  if (options?.dryRun) {
    console.log("Dry-run activo: se omite envio real a Telegram.");
    return;
  }

  const { botToken, chatId } = getTelegramConfig();
  const url = `${TELEGRAM_API_BASE_URL}/bot${botToken}/sendMessage`;

  await requestJson(url, {
    method: "POST",
    body: {
      chat_id: chatId,
      text
    }
  });
}
