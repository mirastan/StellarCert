import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule } from '@nestjs/config';

import { Certificate } from './entities/certificate.entity';
import { Verification } from './entities/verification.entity';

import { CertificateService } from './certificate.service';
import { CertificateStatsService } from './services/stats.service';
import { DuplicateDetectionService } from './services/duplicate-detection.service';
import { CertificatePdfService } from './services/pdf.service';

import { CertificateController } from './certificate.controller';
import { DuplicateDetectionController } from './controllers/duplicate-detection.controller';

import { MetadataSchemaModule } from '../metadata-schema/metadata-schema.module';
import { AuthModule } from '../auth/auth.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { StellarModule } from '../stellar/stellar.module';
import { AuditModule } from '../audit/audit.module';
import { FilesModule } from '../files/files.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Certificate, Verification]),
    CacheModule.register({
      ttl: 300,
      max: 100,
    }),
    ConfigModule,
    MetadataSchemaModule,
    AuthModule,
    WebhooksModule,
    StellarModule,
    AuditModule,
    FilesModule,
    NotificationsModule,
    EmailModule,
  ],
  controllers: [
    CertificateController,
    DuplicateDetectionController,
  ],
  providers: [
    CertificateService,
    CertificateStatsService,
    DuplicateDetectionService,
    CertificatePdfService,
  ],
  exports: [CertificateService, CertificateStatsService],
})
export class CertificateModule {}
