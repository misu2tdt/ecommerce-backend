import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../../auth/auth.guard';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { DEMO_SIMULATE_THROTTLE } from '../../config/throttling';
import { DemoPaymentsEnabledGuard } from './demo-payments-enabled.guard';
import { DemoPaymentsService } from './demo-payments.service';
import { DemoSimulatorService } from './demo-simulator.service';
import { CompleteDemoPaymentDto } from './dto/complete-demo-payment.dto';
import { SimulateDemoPaymentDto } from './dto/simulate-demo-payment.dto';
import { ParseIdPipe } from '../../validation/parse-id.pipe';

// The enabled-guard comes first: with PAYMENT_PROVIDER other than demo this
// route answers 404 before anything else (even before the JWT check).
@Controller('payments/:paymentId/demo')
@UseGuards(DemoPaymentsEnabledGuard, AuthGuard)
@ApiTags('Payments')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class DemoPaymentsController {
  constructor(
    private readonly demoPayments: DemoPaymentsService,
    private readonly simulator: DemoSimulatorService,
  ) {}

  @Post('complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Finish a demo payment (PAYMENT_PROVIDER=demo only)',
    description:
      'Portfolio demo only, no real money. Sends success, failure or cancel for an owned demo payment through the same processing as a real provider callback. Amount and currency come from the stored payment. Repeating the same outcome is harmless.',
  })
  @ApiBadRequestResponse({ description: 'Unknown outcome or extra fields.' })
  @ApiNotFoundResponse({
    description:
      'Demo payments are off, or the payment is not an owned demo payment.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        outcome: 'success',
        result: 'applied',
        payment: {
          id: 42,
          provider: 'demo',
          amount: 400000,
          currency: 'VND',
          status: 'succeeded',
          createdAt: '2026-08-15T08:00:00.000Z',
          updatedAt: '2026-08-15T08:00:05.000Z',
          succeededAt: '2026-08-15T08:00:05.000Z',
        },
        order: { id: 12, status: 'confirmed' },
      },
    },
  })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseIdPipe) paymentId: number,
    @Body() dto: CompleteDemoPaymentDto,
  ) {
    return this.demoPayments.complete(user.id, paymentId, dto.outcome);
  }

  // A tighter allowance than ordinary routes, per signed-in user: a scenario
  // writes to the database and one of them cancels an order.
  @Post('simulate')
  @Throttle({ default: DEMO_SIMULATE_THROTTLE })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run a payment scenario (PAYMENT_PROVIDER=demo only)',
    description:
      'Portfolio demo only, no real money. Runs one scenario on an open demo payment of your own order: success, declined, cancelled, success_twice, success_after_expiry (expiry is forced, not waited for), delayed_success (delivered after about 10 seconds) or invalid_signature. Every event is built and signed by the API and sent through the same processing as a real provider callback. The answer lists each step, then the payment and the order as they are.',
  })
  @ApiBadRequestResponse({ description: 'Unknown scenario or extra fields.' })
  @ApiNotFoundResponse({
    description:
      'Demo payments are off, or the payment is not an owned demo payment.',
  })
  @ApiConflictResponse({
    description:
      'The payment is already finished, or the scenario is not allowed now (see the message).',
  })
  @ApiOkResponse({
    description: 'steps[], the final payment and order, and an explanation.',
  })
  simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', ParseIdPipe) paymentId: number,
    @Body() dto: SimulateDemoPaymentDto,
  ) {
    return this.simulator.simulate(user.id, paymentId, dto.scenario);
  }
}
