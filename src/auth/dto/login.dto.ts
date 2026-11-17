import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from '../../users/email';

export class LoginDto {
  @ApiProperty({ example: 'developer@example.test', format: 'email' })
  @NormalizeEmail()
  @IsString()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'fictional-password', minLength: 1 })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
