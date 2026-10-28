import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  let query: jest.Mock;

  beforeEach(async () => {
    query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, { provide: DataSource, useValue: { query } }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('health', () => {
    it('pings the database and returns a secret-free ok response', async () => {
      await expect(appController.getHealth()).resolves.toEqual({
        status: 'ok',
      });
      expect(query).toHaveBeenCalledWith('SELECT 1');
    });

    it('answers 503 without leaking details when the database is down', async () => {
      query.mockRejectedValue(new Error('password authentication failed'));

      const failure = await appController.getHealth().catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ServiceUnavailableException);
      const exception = failure as ServiceUnavailableException;
      expect(exception.getStatus()).toBe(503);
      expect(exception.getResponse()).toEqual({ status: 'unavailable' });
    });
  });
});
