import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { DEMO_SCENARIOS, type DemoScenario } from '../demo-scenarios';

// Only the scenario comes from the client. Every event is built and signed by the
// API from the stored payment; the global validation pipe rejects extra fields.
export class SimulateDemoPaymentDto {
  @ApiProperty({ enum: DEMO_SCENARIOS, example: 'success_twice' })
  @IsIn(DEMO_SCENARIOS)
  scenario!: DemoScenario;
}
