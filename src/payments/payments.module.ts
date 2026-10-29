import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import {
  getPaymentCurrency,
  getPaymentProviderMode,
  type PaymentProviderMode,
} from '../config/environment';
import { Order } from '../orders/entities/order.entity';
import { PaymentEvent } from './entities/payment-event.entity';
import { Payment } from './entities/payment.entity';
import { DemoPaymentsController } from './demo/demo-payments.controller';
import { DemoPaymentsEnabledGuard } from './demo/demo-payments-enabled.guard';
import { DemoPaymentProvider } from './demo/demo-payment.provider';
import { DemoPaymentsService } from './demo/demo-payments.service';
import { FakePaymentProvider } from './fake-payment.provider';
import { PaymentProvider } from './payment-provider';
import {
  DEFAULT_PAYMENT_CURRENCY,
  PAYMENT_CURRENCY,
  PAYMENT_PROVIDER_MODE,
} from './payments.constants';
import {
  MomoPaymentReturnController,
  PaymentsController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import { getMomoConfig, MomoConfig } from './momo/momo.config';
import { MOMO_CONFIG, MOMO_HTTP_CLIENT } from './momo/momo.constants';
import { FetchMomoHttpClient, MomoHttpClient } from './momo/momo-http.client';
import { MomoIpnService } from './momo/momo-ipn.service';
import { MomoPaymentProvider } from './momo/momo-payment.provider';
import { MomoWebhookController } from './momo/momo-webhook.controller';
import { AdminPaymentReconciliationController } from './reconciliation/admin-payment-reconciliation.controller';
import { PaymentReconciliationService } from './reconciliation/payment-reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentEvent, Order]),
    AuthModule,
  ],
  controllers: [
    PaymentsController,
    MomoPaymentReturnController,
    DemoPaymentsController,
    MomoWebhookController,
    AdminPaymentReconciliationController,
  ],
  providers: [
    PaymentsService,
    PaymentReconciliationService,
    FakePaymentProvider,
    {
      provide: MOMO_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): MomoConfig =>
        process.env.NODE_ENV === 'test'
          ? testMomoConfig()
          : getMomoConfig((key) => configService.get(key)),
    },
    { provide: MOMO_HTTP_CLIENT, useClass: FetchMomoHttpClient },
    {
      provide: PAYMENT_PROVIDER_MODE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        getPaymentProviderMode((key) => configService.get(key)),
    },
    DemoPaymentsEnabledGuard,
    DemoPaymentsService,
    {
      provide: PaymentProvider,
      inject: [
        PAYMENT_PROVIDER_MODE,
        MOMO_CONFIG,
        MOMO_HTTP_CLIENT,
        FakePaymentProvider,
      ],
      useFactory: (
        mode: PaymentProviderMode,
        config: MomoConfig,
        httpClient: MomoHttpClient,
        fakeProvider: FakePaymentProvider,
      ) => {
        if (mode === 'demo') {
          DemoPaymentProvider.announce();
          return new DemoPaymentProvider();
        }
        return process.env.NODE_ENV === 'test'
          ? fakeProvider
          : new MomoPaymentProvider(config, httpClient);
      },
    },
    MomoIpnService,
    {
      provide: PAYMENT_CURRENCY,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        getPaymentCurrency(
          (key) => configService.get(key),
          DEFAULT_PAYMENT_CURRENCY,
        ),
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}

function testMomoConfig(): MomoConfig {
  return {
    partnerCode: 'test-partner',
    accessKey: 'test-access',
    secretKey: 'test-secret',
    identitySecret: 'test-identity-secret',
    endpoint: 'https://test-payment.momo.vn',
    redirectUrl: 'https://example.test/payment-return',
    ipnUrl: 'https://example.test/payments/webhooks/momo',
    timeoutMs: 30_000,
  };
}
