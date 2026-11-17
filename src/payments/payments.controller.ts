import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { PaymentsService } from './payments.service';
import { ParseIdPipe } from '../validation/parse-id.pipe';

@Controller('orders/:orderId/payments')
@UseGuards(AuthGuard)
@ApiTags('Payments')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @ApiBadRequestResponse({ description: 'Invalid or missing Idempotency-Key.' })
  @ApiNotFoundResponse({ description: 'Owned Order not found.' })
  @ApiConflictResponse({ description: 'Order state or idempotency conflict.' })
  @ApiBadGatewayResponse({
    description: 'Payment provider creation failed or is ambiguous.',
  })
  @ApiOperation({
    summary: 'Create or retry a Payment attempt for an owned Order',
    description:
      'Uses integer VND. Reuse the same Idempotency-Key for retries of the same logical request.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '8–128 characters: letters, digits, dot, underscore, colon or hyphen.',
    example: 'checkout-attempt-2026-001',
  })
  @ApiOkResponse({
    description:
      'Safe Payment fields. checkoutUrl is included when provider creation succeeds; clientData may also be present.',
    schema: {
      example: {
        id: 42,
        provider: 'momo',
        amount: 24990000,
        currency: 'VND',
        status: 'processing',
        createdAt: '2026-08-15T08:00:00.000Z',
        updatedAt: '2026-08-15T08:00:00.000Z',
        succeededAt: null,
        checkoutUrl: 'https://test-payment.momo.vn/example-checkout',
      },
    },
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseIdPipe) orderId: number,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.paymentsService.createForOrder(
      user.id,
      orderId,
      idempotencyKey,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List Payment attempts for an owned Order' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseIdPipe) orderId: number,
  ) {
    return this.paymentsService.findForOrder(user.id, orderId);
  }
}

@Controller('payments/momo')
@UseGuards(AuthGuard)
@ApiTags('Payments')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class MomoPaymentReturnController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('return/:providerPaymentId')
  @ApiOperation({
    summary: 'Resolve an owned Order from a MoMo browser return identifier',
    description:
      'Returns only the owned Order mapping. Browser return fields do not change Payment state.',
  })
  @ApiNotFoundResponse({ description: 'Owned Payment return not found.' })
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('providerPaymentId') providerPaymentId: string,
  ) {
    return this.paymentsService.findMomoReturnOrder(user.id, providerPaymentId);
  }
}
