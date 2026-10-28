import { IsEnum } from 'class-validator';
import { OrderStatus } from '../entities/order-status.enum';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateOrderStatusDto {
  @ApiProperty({
    enum: OrderStatus,
    example: OrderStatus.PROCESSING,
    description:
      'Lifecycle: pending → confirmed → processing → shipped → delivered. confirmed is set only by a successful payment, never by this endpoint; processing, shipped and delivered require a succeeded payment. Cancellation is allowed only by current domain rules.',
  })
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}
