import {
  Injectable,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as QRCode from 'qrcode';
import { CreateCertificateDto } from './dto/create-certificate.dto';
import { UpdateCertificateDto } from './dto/update-certificate.dto';
import { IssueCertificateDto } from './dto/issue-certificate.dto';
import { RevokeCertificateDto } from './dto/revoke-certificate.dto';
import { SearchCertificatesDto } from './dto/search-certificates.dto';
import { Certificate } from './entities/certificate.entity';
import { Verification } from './entities/verification.entity';
import { User } from '../users/entities/user.entity';
import { DuplicateDetectionService } from './services/duplicate-detection.service';
import { DuplicateDetectionConfig } from './interfaces/duplicate-detection.interface';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookEvent } from '../webhooks/entities/webhook-subscription.entity';
import { MetadataSchemaService } from '../metadata-schema/services/metadata-schema.service';

@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);
  private readonly enableSoroban: boolean;

  constructor(
    @InjectRepository(Certificate)
    private readonly certificateRepository: Repository<Certificate>,
    @InjectRepository(Verification)
    private readonly verificationRepository: Repository<Verification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly duplicateDetectionService: DuplicateDetectionService,
    private readonly webhooksService: WebhooksService,
    private readonly metadataSchemaService: MetadataSchemaService,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    dto: CreateCertificateDto,
    duplicateConfig?: DuplicateDetectionConfig,
    overrideReason?: string,
    ipAddress = 'unknown',
    userAgent = 'unknown',
  ): Promise<Certificate> {
    // Look up recipientId from email if not provided
    let recipientId = dto.recipientId;
    if (!recipientId && dto.recipientEmail) {
      const user = await this.userRepository.findOne({
        where: { email: dto.recipientEmail },
      });
      if (user) {
        recipientId = user.id;
      }
    }

    // Check for duplicates if config is provided
    if (duplicateConfig?.enabled) {
      const duplicateCheck =
        await this.duplicateDetectionService.checkForDuplicates(
          dto,
          duplicateConfig,
        );

      if (duplicateCheck.isDuplicate) {
        if (duplicateCheck.action === 'block') {
          throw new ConflictException({
            message: 'Certificate issuance blocked due to potential duplicate',
            details: duplicateCheck,
          });
        } else if (duplicateCheck.action === 'warn' && !overrideReason) {
          throw new ConflictException({
            message:
              'Warning: Potential duplicate detected. Override reason required.',
            details: duplicateCheck,
            requiresOverride: true,
          });
        }
      }
    }

    if (
      dto.metadataSchemaId &&
      dto.metadata
    ) {
      const validationResult = await this.metadataSchemaService.validate(
        dto.metadataSchemaId,
        dto.metadata,
      );
      if (!validationResult.valid) {
        throw new ConflictException({
          message: 'Certificate metadata failed schema validation',
          errors: validationResult.errors,
          schemaId: validationResult.schemaId,
          schemaVersion: validationResult.schemaVersion,
        });
      }
    }

    // Create a QueryRunner for transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const certificate = queryRunner.manager.create(Certificate, {
        ...dto,
        recipientId,
        expiresAt:
          dto.expiresAt || this.calculateDefaultExpiry(),
        verificationCode:
          dto.verificationCode ||
          this.generateVerificationCode(),
        isDuplicate: false,
      });

      const savedCertificate = await queryRunner.manager.save(certificate);

      // If this was an override, mark it appropriately
      if (overrideReason) {
        savedCertificate.isDuplicate = true;
        savedCertificate.overrideReason = overrideReason;
        await queryRunner.manager.save(savedCertificate);
      }

      // Commit the transaction
      await queryRunner.commitTransaction();

      this.logger.log(
        `Certificate created: ${savedCertificate.id} for ${dto.recipientEmail}`,
      );

      // Trigger webhook event (outside transaction)
      await this.webhooksService.triggerEvent(
        WebhookEvent.CERTIFICATE_ISSUED,
        savedCertificate.issuerId,
        {
          id: savedCertificate.id,
          recipientEmail: savedCertificate.recipientEmail,
          recipientName: savedCertificate.recipientName,
          title: savedCertificate.title,
          issuedAt: savedCertificate.issuedAt,
          status: savedCertificate.status,
        },
      );

      return savedCertificate;
    } catch (error) {
      // Rollback transaction on error
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to create certificate: ${error.message}`,
        error.stack,
      );
      throw error;
    } finally {
      // Release the QueryRunner
      await queryRunner.release();
    }
  }

  async findAll(
    page = 1,
    limit = 10,
    issuerId?: string,
    status?: string,
  ): Promise<{ certificates: Certificate[]; total: number }> {
    const queryBuilder = this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .orderBy('certificate.issuedAt', 'DESC');

    if (issuerId) {
      queryBuilder.andWhere('certificate.issuerId = :issuerId', { issuerId });
    }

    if (status) {
      queryBuilder.andWhere('certificate.status = :status', { status });
    }

    const total = await queryBuilder.getCount();
    const certificates = await queryBuilder
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { certificates, total };
  }

  async findOne(id: string): Promise<Certificate> {
    const certificate = await this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .where('certificate.id = :id', { id })
      .getOne();

    if (!certificate) {
      throw new NotFoundException(`Certificate with ID ${id} not found`);
    }

    return certificate;
  }

  async findByVerificationCode(verificationCode: string): Promise<Certificate> {
    const certificate = await this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .where('certificate.verificationCode = :verificationCode', {
        verificationCode,
      })
      .andWhere('certificate.status = :status', { status: 'active' })
      .getOne();

    if (!certificate) {
      // Record failed verification if we want to track it
      throw new NotFoundException(
        'Certificate not found or invalid verification code',
      );
    }

    return certificate;
  }

  async verifyCertificate(verificationCode: string): Promise<Certificate> {
    try {
      const certificate = await this.findByVerificationCode(verificationCode);

      // Record successful verification
      await this.verificationRepository.save({
        certificate,
        success: true,
        verifiedAt: new Date(),
      });

      // Trigger webhook event
      await this.webhooksService.triggerEvent(
        WebhookEvent.CERTIFICATE_VERIFIED,
        certificate.issuerId,
        {
          id: certificate.id,
          verificationCode,
          verifiedAt: new Date(),
          recipientEmail: certificate.recipientEmail,
        },
      );

      return certificate;
    } catch (error) {
      if (error instanceof NotFoundException) {
        // Option: Record failed verification in DB too
      }
      throw error;
    }
  }

  async update(
    id: string,
    updateCertificateDto: UpdateCertificateDto,
  ): Promise<Certificate> {
    const certificate = await this.findOne(id);

    Object.assign(certificate, updateCertificateDto);

    return this.certificateRepository.save(certificate);
  }

  async revoke(id: string, reason?: string): Promise<Certificate> {
    const certificate = await this.findOne(id);

    certificate.status = 'revoked';
    if (reason) {
      certificate.metadata = {
        ...certificate.metadata,
        revocationReason: reason,
        revokedAt: new Date(),
      };
    }

    const savedCertificate = await this.certificateRepository.save(certificate);

    // Trigger webhook event
    await this.webhooksService.triggerEvent(
      WebhookEvent.CERTIFICATE_REVOKED,
      savedCertificate.issuerId,
      {
        id: savedCertificate.id,
        status: savedCertificate.status,
        revocationReason: reason,
        revokedAt: new Date(),
      },
    );

    return savedCertificate;
  }

  async freeze(id: string, reason?: string): Promise<Certificate> {
    const certificate = await this.findOne(id);

    if (certificate.status !== 'active') {
      throw new ConflictException(
        `Certificate must be active to freeze. Current status: ${certificate.status}`,
      );
    }

    certificate.status = 'frozen';
    if (reason) {
      certificate.metadata = {
        ...certificate.metadata,
        freezeReason: reason,
        frozenAt: new Date(),
      };
    }

    const savedCertificate = await this.certificateRepository.save(certificate);

    // Trigger webhook event
    await this.webhooksService.triggerEvent(
      WebhookEvent.CERTIFICATE_REVOKED, // Using existing revoked event, could add new freeze event
      savedCertificate.issuerId,
      {
        id: savedCertificate.id,
        status: savedCertificate.status,
        freezeReason: reason,
        frozenAt: new Date(),
      },
    );

    return savedCertificate;
  }

  async unfreeze(id: string, reason?: string): Promise<Certificate> {
    const certificate = await this.findOne(id);

    if (certificate.status !== 'frozen') {
      throw new ConflictException(
        `Certificate must be frozen to unfreeze. Current status: ${certificate.status}`,
      );
    }

    certificate.status = 'active';
    if (reason) {
      certificate.metadata = {
        ...certificate.metadata,
        unfreezeReason: reason,
        unfrozenAt: new Date(),
      };
    }

    const savedCertificate = await this.certificateRepository.save(certificate);

    // Trigger webhook event
    await this.webhooksService.triggerEvent(
      WebhookEvent.CERTIFICATE_ISSUED, // Using existing issued event, could add new unfreeze event
      savedCertificate.issuerId,
      {
        id: savedCertificate.id,
        status: savedCertificate.status,
        unfreezeReason: reason,
        unfrozenAt: new Date(),
      },
    );

    return savedCertificate;
  }

  async bulkRevoke(
    certificateIds: string[],
    reason?: string,
    issuerId?: string,
    userRole?: string,
  ): Promise<{
    revoked: Certificate[];
    failed: { id: string; error: string }[];
  }> {
    const revoked: Certificate[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of certificateIds) {
      try {
        const certificate = await this.revoke(id, reason);
        revoked.push(certificate);
      } catch (error) {
        failed.push({
          id,
          error: error.message || 'Failed to revoke certificate',
        });
      }
    }

    return { revoked, failed };
  }

  async exportCertificates(
    issuerId?: string,
    status?: string,
  ): Promise<Certificate[]> {
    const queryBuilder = this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .orderBy('certificate.issuedAt', 'DESC');

    if (issuerId) {
      queryBuilder.andWhere('certificate.issuerId = :issuerId', { issuerId });
    }

    if (status) {
      queryBuilder.andWhere('certificate.status = :status', { status });
    }

    return queryBuilder.getMany();
  }

  async bulkExport(certificateIds: string[], filters?: any): Promise<string> {
    const queryBuilder = this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .orderBy('certificate.issuedAt', 'DESC');

    // Apply certificate ID filter if provided
    if (certificateIds && certificateIds.length > 0) {
      queryBuilder.andWhere('certificate.id IN (:...certificateIds)', {
        certificateIds,
      });
    }

    // Apply additional filters
    if (filters) {
      if (filters.search) {
        queryBuilder.andWhere(
          '(certificate.serialNumber ILIKE :search OR certificate.recipientName ILIKE :search OR certificate.recipientEmail ILIKE :search OR certificate.title ILIKE :search)',
          { search: `%${filters.search}%` },
        );
      }

      if (filters.status) {
        queryBuilder.andWhere('certificate.status = :status', {
          status: filters.status,
        });
      }

      if (filters.startDate) {
        queryBuilder.andWhere('certificate.issuedAt >= :startDate', {
          startDate: new Date(filters.startDate),
        });
      }

      if (filters.endDate) {
        queryBuilder.andWhere('certificate.issuedAt <= :endDate', {
          endDate: new Date(filters.endDate),
        });
      }
    }

    const certificates = await queryBuilder.getMany();
    return this.convertToCSV(certificates);
  }

  async exportAllFiltered(filters?: any): Promise<string> {
    const queryBuilder = this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .orderBy('certificate.issuedAt', 'DESC');

    // Apply filters
    if (filters) {
      if (filters.search) {
        queryBuilder.andWhere(
          '(certificate.serialNumber ILIKE :search OR certificate.recipientName ILIKE :search OR certificate.recipientEmail ILIKE :search OR certificate.title ILIKE :search)',
          { search: `%${filters.search}%` },
        );
      }

      if (filters.status) {
        queryBuilder.andWhere('certificate.status = :status', {
          status: filters.status,
        });
      }

      if (filters.startDate) {
        queryBuilder.andWhere('certificate.issuedAt >= :startDate', {
          startDate: new Date(filters.startDate),
        });
      }

      if (filters.endDate) {
        queryBuilder.andWhere('certificate.issuedAt <= :endDate', {
          endDate: new Date(filters.endDate),
        });
      }
    }

    const certificates = await queryBuilder.getMany();
    return this.convertToCSV(certificates);
  }

  private convertToCSV(certificates: Certificate[]): string {
    const headers = [
      'ID',
      'Serial Number',
      'Recipient Name',
      'Recipient Email',
      'Title',
      'Course Name',
      'Issuer Name',
      'Issue Date',
      'Status',
      'Expiry Date',
    ];

    const rows = certificates.map((cert) => [
      cert.id,
      cert.verificationCode || cert.id,
      cert.recipientName,
      cert.recipientEmail,
      cert.title,
      cert.courseName,
      cert.issuer?.name || 'Unknown',
      cert.issuedAt.toISOString().split('T')[0],
      cert.status,
      cert.expiresAt ? cert.expiresAt.toISOString().split('T')[0] : '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n');

    return csvContent;
  }

  async remove(id: string): Promise<void> {
    const certificate = await this.findOne(id);
    await this.certificateRepository.remove(certificate);
  }

  async getCertificatesByRecipient(
    email: string,
    page = 1,
    limit = 10,
  ): Promise<Certificate[]> {
    return this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .where('certificate.recipientEmail = :email', { email })
      .orderBy('certificate.issuedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();
  }

  async getCertificatesByIssuer(
    issuerId: string,
    page = 1,
    limit = 10,
  ): Promise<Certificate[]> {
    return this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .where('certificate.issuerId = :issuerId', { issuerId })
      .orderBy('certificate.issuedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();
  }

  async getDuplicateCertificates(): Promise<Certificate[]> {
    return this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .where('certificate.isDuplicate = :isDuplicate', { isDuplicate: true })
      .orderBy('certificate.issuedAt', 'DESC')
      .getMany();
  }

  // Additional methods from main branch
  async search(dto: SearchCertificatesDto): Promise<any> {
    const queryBuilder = this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer');

    if ((dto as any).search) {
      queryBuilder.andWhere(
        '(certificate.title ILIKE :search OR certificate.recipientName ILIKE :search OR certificate.recipientEmail ILIKE :search)',
        { search: `%${(dto as any).search}%` },
      );
    }

    if ((dto as any).status) {
      queryBuilder.andWhere('certificate.status = :status', { status: (dto as any).status });
    }

    if ((dto as any).issuerId) {
      queryBuilder.andWhere('certificate.issuerId = :issuerId', { issuerId: (dto as any).issuerId });
    }

    if ((dto as any).page && (dto as any).limit) {
      queryBuilder.skip(((dto as any).page - 1) * (dto as any).limit).take((dto as any).limit);
    }

    return queryBuilder.orderBy('certificate.issuedAt', 'DESC').getMany();
  }

  async verifyByCode(
    code: string,
    verifiedBy: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<any> {
    return this.verifyCertificate(code);
  }

  async verifyByStellarHash(
    hash: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<any> {
    // Placeholder for Stellar verification
    const certificate = await this.certificateRepository.findOne({
      where: { stellarTxHash: hash } as any,
    });
    if (!certificate) {
      throw new NotFoundException('Certificate not found for this Stellar transaction');
    }
    return certificate;
  }

  async getUserCertificates(
    userId: string,
    page = 1,
    limit = 10,
  ): Promise<Certificate[]> {
    return this.certificateRepository
      .createQueryBuilder('certificate')
      .leftJoinAndSelect('certificate.issuer', 'issuer')
      .where('certificate.recipientId = :userId', { userId })
      .orderBy('certificate.issuedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();
  }

  async getCertificateQrCode(id: string): Promise<any> {
    const certificate = await this.findOne(id);
    const verificationUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify/${certificate.verificationCode}`;
    const qrCode = await QRCode.toDataURL(verificationUrl);
    return {
      id: certificate.id,
      verificationCode: certificate.verificationCode,
      qrCode,
      verificationUrl,
    };
  }

  async getStellarTransactionData(id: string): Promise<any> {
    const certificate = await this.findOne(id);
    return {
      stellarTxHash: (certificate as any).stellarTxHash,
      stellarNetwork: (certificate as any).stellarNetwork,
      issuedAt: certificate.issuedAt,
    };
  }

  async getVerificationHistory(id: string): Promise<Verification[]> {
    return this.verificationRepository.find({
      where: { certificate: { id } as any },
      order: { verifiedAt: 'DESC' },
    });
  }

  async exportCertificate(id: string): Promise<any> {
    const certificate = await this.findOne(id);
    return {
      ...certificate,
      issuer: certificate.issuer,
    };
  }

  async issue(
    dto: IssueCertificateDto,
    userId: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<Certificate> {
    return this.create(
      dto as CreateCertificateDto,
      (dto as any).duplicateConfig,
      (dto as any).overrideReason,
      ipAddress,
      userAgent,
    );
  }

  async updateWithUser(
    id: string,
    updateCertificateDto: UpdateCertificateDto,
    userId: string,
  ): Promise<Certificate> {
    const certificate = await this.findOne(id);
    Object.assign(certificate, updateCertificateDto);
    return this.certificateRepository.save(certificate);
  }

  async revokeWithUser(
    id: string,
    dto: RevokeCertificateDto,
    userId: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<Certificate> {
    return this.revoke(id, dto.reason);
  }

  private calculateDefaultExpiry(): Date {
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 1); // Default 1 year expiry
    return expiry;
  }

  private generateVerificationCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}
