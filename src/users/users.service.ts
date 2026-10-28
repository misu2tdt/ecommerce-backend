import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async register(createUserDto: CreateUserDto) {
    const { email, password } = createUserDto;

    // 1. Check whether the email is already taken
    const existingUser = await this.usersRepository.findOne({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException('This email is already registered.');
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

    // 4. Save to the database
    await this.usersRepository.save(newUser);

    // 5. Return the user details without the password
    return {
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      message: 'Registration successful',
    };
  }
}
