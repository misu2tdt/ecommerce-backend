import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly chatId: string;

  constructor(private configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.chatId =
      this.configService.get<string>('TELEGRAM_CHAT_ID') ||
      this.configService.get<string>('TELEGRAM_ADMIN_CHAT_ID') ||
      '';
  }

  async sendMessage(message: string) {
    if (!this.botToken || !this.chatId) {
      this.logger.warn(
        'Telegram bot token or chat ID is missing. Check your environment configuration.',
      );
      return;
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        this.logger.error(
          `Failed to send Telegram message: ${response.statusText}`,
        );
      } else {
        this.logger.log('Telegram message sent successfully');
      }
    } catch (error) {
      this.logger.error('Could not connect to Telegram', error);
    }
  }
}
