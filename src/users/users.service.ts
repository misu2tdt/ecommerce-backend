import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { isUniqueViolation } from '../catalog/database-errors';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { isReservedEmailDomain, normalizeEmail } from './email';

const EMAIL_TAKEN = 'This email is already registered.';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async register(createUserDto: CreateUserDto) {
    const { password } = createUserDto;
    // One account per address, whatever its case (A@x.com and a@x.com are the
    // same account) or surrounding spaces.
    const email = normalizeEmail(createUserDto.email);

    if (isReservedEmailDomain(email)) {
      throw new BadRequestException('This email domain is reserved.');
    }

    // 1. Check whether the email is already taken, ignoring case so that an
    // older account stored with capital letters is found too
    const existingUser = await this.usersRepository
      .createQueryBuilder('user')
      .select('user.id')
      .where('LOWER("user"."email") = :email', { email })
      .getOne();
    if (existingUser) {
      throw new ConflictException(EMAIL_TAKEN);
    }

    // 2. Hash the password with bcrypt (10 salt rounds)
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 3. Create the new user with the hashed password
    const newUser = this.usersRepository.create({
      email: email,
      password: hashedPassword,
      // the role falls back to the entity default ('user')
    });

    // 4. Save to the database. Two requests for the same email at the same
    // moment both pass the check above; the unique index lets one of them in and
    // refuses the other, which gets the same 409 as the check.
    try {
      await this.usersRepository.save(newUser);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(EMAIL_TAKEN);
      throw error;
    }

    // 5. Return the user details without the password
    return {
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      message: 'Registration successful',
    };
  }
}
