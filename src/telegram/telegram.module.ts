import { Module, Global } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Global() // Bùa chú này biến Module thành xài chung toàn công ty
@Module({
  providers: [TelegramService],
  exports: [TelegramService], // Mở cửa sổ cho người khác gọi Service này
})
export class TelegramModule {}
