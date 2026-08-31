import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { isUniqueViolation } from '../catalog/database-errors';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { CouponType } from './entities/coupon-type.enum';
import { Coupon } from './entities/coupon.entity';
import {
  calculateOrderPricing,
  normalizeCouponCode,
  validateCouponEligibility,
} from './promotions-calculator';

@Injectable()
export class PromotionsService {
  constructor(private readonly dataSource: DataSource) {}

  private getRepository(manager?: EntityManager): Repository<Coupon> {
    return manager
      ? manager.getRepository(Coupon)
      : this.dataSource.getRepository(Coupon);
  }

  async findByCode(
    code: string,
    manager?: EntityManager,
  ): Promise<Coupon | null> {
    const normalized = normalizeCouponCode(code);
    if (!normalized) return null;
    return this.getRepository(manager).findOneBy({ code: normalized });
  }

  async findAndValidate(
    code: string,
    subtotal: number,
    now: Date = new Date(),
    manager?: EntityManager,
  ): Promise<Coupon> {
    const normalized = normalizeCouponCode(code);
    if (!normalized) {
      throw new BadRequestException('Coupon code is invalid');
    }

    const coupon = await this.findByCode(normalized, manager);
    if (!coupon) {
      throw new NotFoundException('Coupon code does not exist');
    }

    validateCouponEligibility(coupon, subtotal, now);
    return coupon;
  }

  calculatePricing(subtotal: number, coupon?: Coupon | null, now?: Date) {
    return calculateOrderPricing(subtotal, coupon, now);
  }

  // --- Admin Methods ---

  async findAllForAdmin() {
    const coupons = await this.dataSource.getRepository(Coupon).find({
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return coupons.map((c) => this.toCouponView(c));
  }

  async findOneForAdmin(id: number) {
    const coupon = await this.dataSource
      .getRepository(Coupon)
      .findOneBy({ id });
    if (!coupon) throw new NotFoundException('Coupon not found');
    return this.toCouponView(coupon);
  }

  async create(dto: CreateCouponDto) {
    const code = normalizeCouponCode(dto.code);
    if (!code) {
      throw new BadRequestException('Coupon code is required');
    }

    this.validateCouponDtoRules(dto);

    const repo = this.dataSource.getRepository(Coupon);
    const existing = await repo.findOneBy({ code });
    if (existing) {
      throw new ConflictException(`Coupon code '${code}' already exists`);
    }

    const coupon = repo.create({
      code,
      name: dto.name.trim(),
      type: dto.type,
      value: dto.value,
      minSubtotal: dto.minSubtotal ?? null,
      maxDiscount:
        dto.type === CouponType.PERCENTAGE ? (dto.maxDiscount ?? null) : null,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      isActive: dto.isActive !== undefined ? dto.isActive : true,
    });

    try {
      const saved = await repo.save(coupon);
      return this.toCouponView(saved);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`Coupon code '${code}' already exists`);
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateCouponDto) {
    const repo = this.dataSource.getRepository(Coupon);
    const coupon = await repo.findOneBy({ id });
    if (!coupon) throw new NotFoundException('Coupon not found');

    if (dto.code !== undefined) {
      const code = normalizeCouponCode(dto.code);
      if (!code) throw new BadRequestException('Coupon code cannot be empty');
      if (code !== coupon.code) {
        const existing = await repo.findOneBy({ code });
        if (existing) {
          throw new ConflictException(`Coupon code '${code}' already exists`);
        }
        coupon.code = code;
      }
    }

    const mergedDto: CreateCouponDto = {
      code: coupon.code,
      name: dto.name ?? coupon.name,
      type: dto.type ?? coupon.type,
      value: dto.value ?? coupon.value,
      minSubtotal:
        dto.minSubtotal !== undefined ? dto.minSubtotal : coupon.minSubtotal,
      maxDiscount:
        dto.maxDiscount !== undefined ? dto.maxDiscount : coupon.maxDiscount,
      startsAt:
        dto.startsAt !== undefined
          ? dto.startsAt
          : coupon.startsAt?.toISOString(),
      endsAt:
        dto.endsAt !== undefined ? dto.endsAt : coupon.endsAt?.toISOString(),
      isActive: dto.isActive !== undefined ? dto.isActive : coupon.isActive,
    };

    this.validateCouponDtoRules(mergedDto);

    if (dto.name !== undefined) coupon.name = dto.name.trim();
    if (dto.type !== undefined) coupon.type = dto.type;
    if (dto.value !== undefined) coupon.value = dto.value;
    if (dto.minSubtotal !== undefined) coupon.minSubtotal = dto.minSubtotal;
    if (dto.maxDiscount !== undefined) {
      coupon.maxDiscount =
        coupon.type === CouponType.PERCENTAGE ? dto.maxDiscount : null;
    } else if (coupon.type === CouponType.FIXED) {
      coupon.maxDiscount = null;
    }
    if (dto.startsAt !== undefined)
      coupon.startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    if (dto.endsAt !== undefined)
      coupon.endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (dto.isActive !== undefined) coupon.isActive = dto.isActive;

    try {
      const saved = await repo.save(coupon);
      return this.toCouponView(saved);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Coupon code '${coupon.code}' already exists`,
        );
      }
      throw error;
    }
  }

  async toggleActive(id: number) {
    const repo = this.dataSource.getRepository(Coupon);
    const coupon = await repo.findOneBy({ id });
    if (!coupon) throw new NotFoundException('Coupon not found');
    coupon.isActive = !coupon.isActive;
    const saved = await repo.save(coupon);
    return this.toCouponView(saved);
  }

  private validateCouponDtoRules(dto: Partial<CreateCouponDto>) {
    if (dto.type === CouponType.PERCENTAGE) {
      if (dto.value !== undefined && (dto.value < 1 || dto.value > 100)) {
        throw new BadRequestException(
          'Percentage discount value must be between 1 and 100',
        );
      }
      if (
        dto.maxDiscount !== undefined &&
        dto.maxDiscount !== null &&
        dto.maxDiscount <= 0
      ) {
        throw new BadRequestException(
          'Maximum discount must be greater than zero when specified',
        );
      }
    } else if (dto.type === CouponType.FIXED) {
      if (dto.value !== undefined && dto.value <= 0) {
        throw new BadRequestException(
          'Fixed discount value must be a positive integer',
        );
      }
      if (dto.maxDiscount !== undefined && dto.maxDiscount !== null) {
        throw new BadRequestException(
          'Fixed discount coupons cannot have a maximum discount cap',
        );
      }
    }

    if (dto.startsAt && dto.endsAt) {
      const start = new Date(dto.startsAt).getTime();
      const end = new Date(dto.endsAt).getTime();
      if (start >= end) {
        throw new BadRequestException('startsAt must be before endsAt');
      }
    }
  }

  toCouponView(coupon: Coupon) {
    return {
      id: coupon.id,
      code: coupon.code,
      name: coupon.name,
      type: coupon.type,
      value: coupon.value,
      minSubtotal: coupon.minSubtotal,
      maxDiscount: coupon.maxDiscount,
      startsAt: coupon.startsAt ? coupon.startsAt.toISOString() : null,
      endsAt: coupon.endsAt ? coupon.endsAt.toISOString() : null,
      isActive: coupon.isActive,
      createdAt: coupon.createdAt.toISOString(),
      updatedAt: coupon.updatedAt.toISOString(),
    };
  }
}
