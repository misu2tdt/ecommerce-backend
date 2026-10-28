import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../../auth/auth.guard';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Roles } from '../../auth/roles.decorator';
import { RolesGuard } from '../../auth/roles.guard';
import { UserRole } from '../../users/entities/user-role.enum';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';
import { ResolveReconciliationDto } from './dto/resolve-reconciliation.dto';
import { PaymentReconciliationService } from './payment-reconciliation.service';

const ITEM_EXAMPLE = {
  id: 17,
  createdAt: '2026-10-28T09:30:00.000Z',
  eventType: 'succeeded',
  processingMessage:
    'Provider success conflicts with terminal Payment or non-pending Order',
  provider: 'momo',
  providerPaymentId: 'PAY42-abc123',
  payment: { id: 42, status: 'cancelled', amount: 24990000, currency: 'VND' },
  order: { id: 7, status: 'cancelled', userId: 3 },
  suggestedAction:
    'Refund or manually fulfil: success after the order was cancelled',
  resolvedAt: null,
  resolvedByUserId: null,
  resolutionNote: null,
};

@Controller('admin/payments/reconciliation')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin - Payments')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
@ApiForbiddenResponse({ description: 'ADMIN role required.' })
export class AdminPaymentReconciliationController {
  constructor(
    private readonly reconciliationService: PaymentReconciliationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List payment events that need manual reconciliation',
    description:
      'ADMIN only. Events a provider callback could not apply cleanly, such as a success after the Order was cancelled. Newest first; unresolved by default.',
  })
  @ApiBadRequestResponse({
    description: 'Invalid page, limit (max 100) or status.',
  })
  @ApiOkResponse({
    schema: {
      example: { items: [ITEM_EXAMPLE], page: 1, limit: 20, total: 1 },
    },
  })
  list(@Query() query: ReconciliationQueryDto) {
    return this.reconciliationService.list(query);
  }

  @Post(':eventId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record that a reconciliation event was handled',
    description:
      'ADMIN only. Stores who handled it, when and a note. It does not change any Order, Payment or stock; there is no refund feature yet.',
  })
  @ApiBadRequestResponse({ description: 'Note must be 3-500 characters.' })
  @ApiNotFoundResponse({ description: 'Payment event not found.' })
  @ApiConflictResponse({
    description:
      'The event does not require reconciliation, or is already resolved.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        ...ITEM_EXAMPLE,
        resolvedAt: '2026-10-28T10:15:00.000Z',
        resolvedByUserId: 1,
        resolutionNote: 'Refunded manually in the MoMo merchant portal',
      },
    },
  })
  resolve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('eventId', ParseIntPipe) eventId: number,
    @Body() dto: ResolveReconciliationDto,
  ) {
    return this.reconciliationService.resolve(eventId, admin.id, dto.note);
  }
}
