import { NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AddressesService } from './addresses.service';
import { Address } from './entities/address.entity';

describe('AddressesService', () => {
  const addressRepo = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const userRepo = { findOne: jest.fn() };
  const manager = {
    getRepository: jest.fn((entity) =>
      entity === Address ? addressRepo : userRepo,
    ),
  };
  const dataSource = {
    transaction: jest.fn((work: (manager: EntityManager) => unknown) =>
      work(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn(() => addressRepo),
  };
  let service: AddressesService;

  beforeEach(() => {
    jest.clearAllMocks();
    userRepo.findOne.mockResolvedValue({ id: 7 });
    addressRepo.create.mockImplementation((value) => value);
    addressRepo.save.mockImplementation(async (value) => ({ id: 1, ...value }));
    addressRepo.update.mockResolvedValue({ affected: 1 });
    addressRepo.delete.mockResolvedValue({ affected: 1 });
    service = new AddressesService(dataSource as unknown as DataSource);
  });

  it('creates an owned Address and normalizes countryCode', async () => {
    await expect(
      service.create(7, dto({ countryCode: 'vn' })),
    ).resolves.toEqual(
      expect.objectContaining({ userId: 7, countryCode: 'VN' }),
    );
  });

  it('switches the default atomically after locking User', async () => {
    await service.create(7, dto({ isDefault: true }));
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { id: 7 },
      lock: { mode: 'pessimistic_write' },
    });
    expect(addressRepo.update).toHaveBeenCalledWith(
      { userId: 7, isDefault: true },
      { isDefault: false },
    );
    expect(addressRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true }),
    );
  });

  it('returns 404 for an Address not owned by the user', async () => {
    addressRepo.findOne.mockResolvedValue(null);
    await expect(
      service.update(7, 99, { city: 'Other' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    addressRepo.delete.mockResolvedValue({ affected: 0 });
    await expect(service.remove(7, 99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('deletes a default Address without promoting another', async () => {
    await service.remove(7, 1);
    expect(addressRepo.delete).toHaveBeenCalledWith({ id: 1, userId: 7 });
    expect(addressRepo.update).not.toHaveBeenCalled();
  });

  function dto(overrides: Record<string, unknown> = {}) {
    return {
      recipientName: 'Recipient',
      phone: '+12025550123',
      addressLine1: 'Address line',
      city: 'City',
      countryCode: 'US',
      ...overrides,
    } as never;
  }
});
