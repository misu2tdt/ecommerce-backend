import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UserRole } from '../users/entities/user-role.enum';
import { AuthenticatedUser, JwtPayload } from './auth.types';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Bạn chưa xuất trình Token!');
    }

    try {
      const payload =
        await this.jwtService.verifyAsync<Record<string, unknown>>(token);

      if (!this.isValidPayload(payload)) {
        throw new UnauthorizedException();
      }

      request.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
    } catch {
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn!');
    }

    return true;
  }

  private isValidPayload(
    payload: Record<string, unknown>,
  ): payload is Record<string, unknown> & JwtPayload {
    return (
      typeof payload.sub === 'number' &&
      Number.isInteger(payload.sub) &&
      payload.sub > 0 &&
      typeof payload.email === 'string' &&
      payload.email.length > 0 &&
      (payload.role === UserRole.USER || payload.role === UserRole.ADMIN)
    );
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
