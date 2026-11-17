import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from '../email';

export class CreateUserDto {
  @ApiProperty({ example: 'shopper@example.test', format: 'email' })
  @NormalizeEmail()
  @IsString()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'fictional-password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;
}
