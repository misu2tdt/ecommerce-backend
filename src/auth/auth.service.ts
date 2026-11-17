import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { normalizeEmail } from '../users/email';
import { User } from '../users/entities/user.entity';
import { JwtPayload } from './auth.types';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    private jwtService: JwtService,
  ) {}

  async login(email: string, pass: string) {
    // The address is matched ignoring case and surrounding spaces. Normally one
    // account matches. If an older database holds two accounts that differ only
    // by case, each owner can still sign in with their own password.
    const candidates = await this.userRepo
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.role'])
      .addSelect('user.password')
      .where('LOWER("user"."email") = :email', { email: normalizeEmail(email) })
      .orderBy('user.id', 'ASC')
      .limit(5)
      .getMany();

    let user: User | undefined;
    for (const candidate of candidates) {
      if (await bcrypt.compare(pass, candidate.password)) {
        user = candidate;
        break;
      }
    }
    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    return {
      message: 'Login successful',
      access_token: await this.jwtService.signAsync(payload),
    };
  }
}
