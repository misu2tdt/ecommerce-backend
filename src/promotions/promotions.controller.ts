import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UserRole } from '../users/entities/user-role.enum';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { PromotionsService } from './promotions.service';

@Controller('admin/promotions')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiTags('Admin - Promotions')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List all promotional coupons',
    description: 'ADMIN only.',
  })
  findAll() {
    return this.promotionsService.findAllForAdmin();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a promotional coupon by ID',
    description: 'ADMIN only.',
  })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.findOneForAdmin(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a promotional coupon',
    description: 'ADMIN only.',
  })
  create(@Body() dto: CreateCouponDto) {
    return this.promotionsService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a promotional coupon',
    description: 'ADMIN only.',
  })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCouponDto) {
    return this.promotionsService.update(id, dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({
    summary: 'Toggle active status of a promotional coupon',
    description: 'ADMIN only.',
  })
  toggleActive(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.toggleActive(id);
  }
}
