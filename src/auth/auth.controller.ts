import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AUTH_THROTTLE } from '../config/throttling';
import { UserRole } from '../users/entities/user-role.enum';
import type { AuthenticatedUser } from './auth.types';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ default: AUTH_THROTTLE })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({
    description: 'Authenticated successfully.',
    schema: {
      example: {
        message: 'Login successful',
        access_token: '<JWT>',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto.email, loginDto.password);
  }

  @UseGuards(AuthGuard)
  @Get('me')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Get the authenticated user identity' })
  @ApiOkResponse({
    description: 'Verified identity from the bearer token.',
    schema: {
      example: {
        id: 1,
        email: 'shopper@example.test',
        role: UserRole.USER,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired token.',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
