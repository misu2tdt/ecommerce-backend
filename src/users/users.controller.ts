import { Controller, Post, Body } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ipOnlyTracker, REGISTER_THROTTLE } from '../config/throttling';

@Controller('users')
@ApiTags('Users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Per client IP only: a token in the request does not widen the allowance.
  @Throttle({ default: { ...REGISTER_THROTTLE, getTracker: ipOnlyTracker } })
  @Post('register')
  @ApiOperation({ summary: 'Register a user account' })
  @ApiCreatedResponse({ description: 'User registered. Password is omitted.' })
  @ApiConflictResponse({ description: 'Email is already registered.' })
  async register(@Body() createUserDto: CreateUserDto) {
    return await this.usersService.register(createUserDto);
  }
}
