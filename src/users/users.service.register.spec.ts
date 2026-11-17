import { BadRequestException, ConflictException } from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

describe('UsersService.register', () => {
  const lookup = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const repository = {
    createQueryBuilder: jest.fn(() => lookup),
    create: jest.fn((value: Partial<User>) => ({ ...value, role: 'user' })),
    save: jest.fn<Promise<Partial<User>>, [Partial<User>]>(),
  };
  let service: UsersService;

  beforeEach(() => {
    jest.clearAllMocks();
    lookup.getOne.mockResolvedValue(null);
    repository.save.mockImplementation((value: Partial<User>) => {
      Object.assign(value, { id: 5 });
      return Promise.resolve(value);
    });
    service = new UsersService(repository as unknown as Repository<User>);
  });

  it('stores the email in lowercase, trimmed', async () => {
    const result = await service.register({
      email: '  Shopper@Example.TEST ',
      password: 'long-enough-1',
    });

    expect(result.email).toBe('shopper@example.test');
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'shopper@example.test' }),
    );
  });

  it('looks for an existing account ignoring case', async () => {
    await service.register({ email: 'A@X.com', password: 'long-enough-1' });

    expect(lookup.where).toHaveBeenCalledWith(
      'LOWER("user"."email") = :email',
      { email: 'a@x.com' },
    );
  });

  it('answers 409 when an account with that email exists', async () => {
    lookup.getOne.mockResolvedValue({ id: 1 });

    await expect(
      service.register({ email: 'a@x.com', password: 'long-enough-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('answers the same 409 when the unique index refuses a simultaneous insert', async () => {
    repository.save.mockRejectedValue(
      new QueryFailedError('INSERT', [], { code: '23505' } as never),
    );

    const failure = await service
      .register({ email: 'a@x.com', password: 'long-enough-1' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).message).toBe(
      'This email is already registered.',
    );
  });

  it('does not hide other database errors', async () => {
    const broken = new QueryFailedError('INSERT', [], {
      code: '40P01',
    } as never);
    repository.save.mockRejectedValue(broken);

    await expect(
      service.register({ email: 'a@x.com', password: 'long-enough-1' }),
    ).rejects.toBe(broken);
  });

  it('refuses the reserved seed domain with a 400, before touching the database', async () => {
    const failure = await service
      .register({
        email: 'Someone@Demo-History.Example.com',
        password: 'long-enough-1',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).message).toBe(
      'This email domain is reserved.',
    );
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });
});
