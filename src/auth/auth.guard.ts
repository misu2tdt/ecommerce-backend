import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthenticatedUser, isJwtPayload } from './auth.types';
import { extractBearerToken } from './bearer-token';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers);

    if (!token) {
      throw new UnauthorizedException('Authentication token is required.');
    }

    try {
      const payload =
        await this.jwtService.verifyAsync<Record<string, unknown>>(token);

      if (!isJwtPayload(payload)) {
        throw new UnauthorizedException();
      }

      request.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
    } catch {
      throw new UnauthorizedException('Token is invalid or has expired.');
    }

    return true;
  }
}
