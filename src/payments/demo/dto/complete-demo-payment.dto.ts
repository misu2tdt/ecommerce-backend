import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const DEMO_OUTCOMES = ['success', 'failure', 'cancel'] as const;
export type DemoOutcome = (typeof DEMO_OUTCOMES)[number];

// Only the outcome comes from the client. The amount, currency and provider
// ids are read from the stored payment, and the global validation pipe rejects
// any extra field.
export class CompleteDemoPaymentDto {
  @ApiProperty({ enum: DEMO_OUTCOMES, example: 'success' })
  @IsIn(DEMO_OUTCOMES)
  outcome!: DemoOutcome;
}
