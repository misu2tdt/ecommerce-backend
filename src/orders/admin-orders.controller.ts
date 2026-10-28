import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/entities/user-role.enum';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrdersService } from './orders.service';

@Controller('admin/orders')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin - Orders')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
@ApiForbiddenResponse({ description: 'ADMIN role required.' })
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'List all Orders', description: 'ADMIN only.' })
  findAll() {
    return this.ordersService.findAllForAdmin();
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Transition an Order status',
    description:
      'ADMIN only. Only configured lifecycle transitions are accepted. An Order is confirmed only by a successful payment, so CONFIRMED is rejected here, and PROCESSING, SHIPPED and DELIVERED require a succeeded payment.',
  })
  @ApiConflictResponse({
    description:
      'CONFIRMED requested by an admin, or the Order has no succeeded payment.',
  })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(id, dto.status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get any Order', description: 'ADMIN only.' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.ordersService.findOneForAdmin(id);
  }
}
