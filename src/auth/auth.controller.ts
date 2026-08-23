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
import { UserRole } from '../users/entities/user-role.enum';
import type { AuthenticatedUser } from './auth.types';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin-only')
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Verify ADMIN access', description: 'ADMIN only.' })
  getAdminDashboard() {
    return { message: 'Chào mừng Sếp! Đây là khu vực mật.' };
  }
}
