import { ConflictException } from '@nestjs/common';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { CouponType } from './entities/coupon-type.enum';
import { Coupon } from './entities/coupon.entity';
import { PromotionsService } from './promotions.service';

describe('PromotionsService save-time race conflict mapping', () => {
  let service: PromotionsService;
  let couponRepo: jest.Mocked<Partial<Repository<Coupon>>>;
  let dataSource: jest.Mocked<Partial<DataSource>>;

  beforeEach(() => {
    couponRepo = {
      findOneBy: jest.fn().mockResolvedValue(null), // Preflight duplicate check passes
      create: jest.fn().mockImplementation((val) => val as Coupon),
      save: jest.fn(),
    };

    dataSource = {
      getRepository: jest
        .fn()
        .mockReturnValue(couponRepo as Repository<Coupon>),
    };

    service = new PromotionsService(dataSource as DataSource);
  });

  const validDto: CreateCouponDto = {
    code: 'RACE10',
    name: 'Race Condition 10%',
    type: CouponType.PERCENTAGE,
    value: 10,
  };

  it('A) catches PostgreSQL 23505 unique violation at save() time and maps to ConflictException', async () => {
    // Simulate preflight check passing, but concurrent insert causes PostgreSQL 23505 unique violation on save()
    const pgUniqueError = new QueryFailedError(
      'INSERT INTO "coupons" ...',
      [],
      new Error(
        'duplicate key value violates unique constraint "UQ_coupons_code"',
      ),
    );
    (
      pgUniqueError as unknown as { driverError: { code: string } }
    ).driverError = {
      code: '23505',
    };

    couponRepo.save = jest.fn().mockRejectedValue(pgUniqueError);

    await expect(service.create(validDto)).rejects.toThrow(ConflictException);
    await expect(service.create(validDto)).rejects.toThrow(
      "Coupon code 'RACE10' already exists",
    );
  });

  it('B) propagates unrelated database errors at save() time without converting to ConflictException', async () => {
    const pgSyntaxError = new QueryFailedError(
      'INSERT INTO "coupons" ...',
      [],
      new Error('relation does not exist'),
    );
    (
      pgSyntaxError as unknown as { driverError: { code: string } }
    ).driverError = {
      code: '42P01',
    };

    couponRepo.save = jest.fn().mockRejectedValue(pgSyntaxError);

    await expect(service.create(validDto)).rejects.toThrow(pgSyntaxError);
    await expect(service.create(validDto)).rejects.not.toThrow(
      ConflictException,
    );
  });

  it('C) propagates standard generic runtime errors at save() time untouched', async () => {
    const genericError = new Error('Database connection pool exhausted');
    couponRepo.save = jest.fn().mockRejectedValue(genericError);

    await expect(service.create(validDto)).rejects.toThrow(
      'Database connection pool exhausted',
    );
    await expect(service.create(validDto)).rejects.not.toThrow(
      ConflictException,
    );
  });
});
