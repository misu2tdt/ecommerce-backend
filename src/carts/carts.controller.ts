import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { CartsService } from './carts.service';
import { QuoteCartDto } from '../promotions/dto/quote-cart.dto';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { CheckoutCartDto } from './dto/checkout-cart.dto';

@Controller('cart')
@UseGuards(AuthGuard)
@ApiTags('Cart')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Bearer JWT is missing or invalid.' })
export class CartsController {
  constructor(private readonly cartsService: CartsService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the current user’s cart',
    description: 'Cart contents do not reserve inventory.',
  })
  getCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cartsService.getCart(user.id);
  }

  @Post('quote')
  @ApiOperation({
    summary: 'Preview cart subtotal, coupon discount, and payable total',
    description: 'Does not reserve inventory or create an order.',
  })
  getQuote(@CurrentUser() user: AuthenticatedUser, @Body() dto: QuoteCartDto) {
    return this.cartsService.getQuote(user.id, dto.couponCode);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Add a ProductVariant to the cart',
    description: 'Cart contents do not reserve inventory.',
  })
  addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto) {
    return this.cartsService.addItem(user.id, dto);
  }

  @Patch('items/:itemId')
  @ApiOperation({ summary: 'Set a cart item quantity' })
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cartsService.updateItem(user.id, itemId, dto);
  }

  @Delete('items/:itemId')
  @ApiOperation({ summary: 'Remove a cart item' })
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    return this.cartsService.removeItem(user.id, itemId);
  }

  @Delete()
  @ApiOperation({ summary: 'Clear the cart' })
  clear(@CurrentUser() user: AuthenticatedUser) {
    return this.cartsService.clear(user.id);
  }

  @Post('checkout')
  @ApiBadRequestResponse({
    description: 'Variant is inactive, unavailable, or has insufficient stock.',
  })
  @ApiOperation({
    summary: 'Checkout the current cart',
    description:
      'Validates current ProductVariant activity and stock transactionally; cart contents did not reserve stock.',
  })
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckoutCartDto,
  ) {
    return this.cartsService.checkout(user.id, dto.addressId, dto.couponCode);
  }
}
