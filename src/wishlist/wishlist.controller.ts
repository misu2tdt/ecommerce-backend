import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { AddWishlistItemDto } from './dto/add-wishlist-item.dto';
import { WishlistService } from './wishlist.service';
import { ParseIdPipe } from '../validation/parse-id.pipe';

@Controller('wishlist')
@UseGuards(AuthGuard)
@ApiTags('Wishlist')
@ApiBearerAuth('bearer')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  @ApiOperation({ summary: 'List the current user’s wishlist' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.wishlistService.findAll(user.id);
  }

  @Post('items')
  @ApiOperation({ summary: 'Add a Product to the wishlist' })
  add(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddWishlistItemDto) {
    return this.wishlistService.add(user.id, dto.productId);
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove a Product from the wishlist' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseIdPipe) productId: number,
  ) {
    return this.wishlistService.remove(user.id, productId);
  }
}
