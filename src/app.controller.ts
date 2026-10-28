import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { AppService } from './app.service';

@Controller()
@ApiTags('System')
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    private readonly dataSource: DataSource,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Basic application reachability check' })
  getHello(): string {
    return this.appService.getHello();
  }

  // Platform health probes must never be rate limited.
  @SkipThrottle()
  @Get('health')
  @ApiOperation({ summary: 'Deployment health check (pings the database)' })
  @ApiOkResponse({ schema: { example: { status: 'ok' } } })
  @ApiServiceUnavailableResponse({
    schema: { example: { status: 'unavailable' } },
  })
  async getHealth(): Promise<{ status: 'ok' }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch (error) {
      // Keep details in the logs only; the response must stay secret-free.
      this.logger.warn(
        `Health check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    return { status: 'ok' };
  }
}
