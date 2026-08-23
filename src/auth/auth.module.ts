import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getJwtExpiration, getRequiredConfig } from '../config/environment';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const readConfig = (key: string) => configService.get<unknown>(key);

        return {
          secret: getRequiredConfig(readConfig, 'JWT_SECRET'),
          signOptions: {
            expiresIn: getJwtExpiration(readConfig),
          },
        };
      },
    }),
  ],
  providers: [AuthService, AuthGuard, RolesGuard],
  controllers: [AuthController],
  exports: [JwtModule, AuthGuard, RolesGuard],
})
export class AuthModule {}
