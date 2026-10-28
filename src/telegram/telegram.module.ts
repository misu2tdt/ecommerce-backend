import { Module, Global } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Global() // Makes this module available application-wide without importing it
@Module({
  providers: [TelegramService],
  exports: [TelegramService], // Lets other modules call this service
})
export class TelegramModule {}
