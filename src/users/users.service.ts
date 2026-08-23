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

    // 1. Kiểm tra xem email đã có ai dùng chưa
    const existingUser = await this.usersRepository.findOne({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException('Email này đã được đăng ký!');
    }

    // 2. Băm nát mật khẩu bằng bcrypt (muối 10 vòng)
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // 3. Tạo user mới với mật khẩu đã băm
    const newUser = this.usersRepository.create({
      email: email,
      password: hashedPassword,
      // role mặc định là 'user' như bản vẽ Entity đã định
    });

    // 4. Lưu vào Database
    await this.usersRepository.save(newUser);

    // 5. Trả về thông tin nhưng GIẤU mật khẩu đi (không in ra màn hình)
    return {
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      message: 'Đăng ký tài khoản thành công!',
    };
  }
}
