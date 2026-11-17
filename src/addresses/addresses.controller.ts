import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AddressesService } from './addresses.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { ParseIdPipe } from '../validation/parse-id.pipe';

@Controller('addresses')
@UseGuards(AuthGuard)
@ApiTags('Addresses')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Get()
  @ApiOperation({ summary: 'List the current user’s saved addresses' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.addressesService.findAll(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a saved address' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
  ) {
    return this.addressesService.create(user.id, dto);
  }

  @Patch(':id')
  @ApiNotFoundResponse({ description: 'Owned Address not found.' })
  @ApiOperation({
    summary: 'Update an owned saved address',
    description:
      'Historical Orders keep an immutable shipping-address snapshot and are not changed.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.addressesService.update(user.id, id, dto);
  }

  @Delete(':id')
  @ApiNotFoundResponse({ description: 'Owned Address not found.' })
  @ApiOperation({
    summary: 'Delete an owned saved address',
    description:
      'Historical Orders keep an immutable shipping-address snapshot and are not changed.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: number,
  ) {
    return this.addressesService.remove(user.id, id);
  }
}
