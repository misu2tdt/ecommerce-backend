import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../../auth/auth.guard';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { DemoPaymentsEnabledGuard } from './demo-payments-enabled.guard';
import { DemoPaymentsService } from './demo-payments.service';
import { CompleteDemoPaymentDto } from './dto/complete-demo-payment.dto';

// The enabled-guard comes first: with PAYMENT_PROVIDER other than demo this
// route answers 404 before anything else (even before the JWT check).
@Controller('payments/:paymentId/demo')
@UseGuards(DemoPaymentsEnabledGuard, AuthGuard)
@ApiTags('Payments')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class DemoPaymentsController {
  constructor(private readonly demoPayments: DemoPaymentsService) {}

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
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: CompleteDemoPaymentDto,
  ) {
    return this.demoPayments.complete(user.id, paymentId, dto.outcome);
  }
}
