import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { TwoFactorService } from './services/two-factor.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutResponseDto } from './dto/logout-response.dto';
import { TwoFactorEnableDto } from './dto/two-factor-enable.dto';
import { TwoFactorVerifyDto } from './dto/two-factor-verify.dto';
import { TwoFactorTokenDto } from './dto/two-factor-token.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimit } from '../security/decorators/rate-limit.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private twoFactorService: TwoFactorService,
  ) {}

  // FIX #269 — login() delegates to authService.login() whose return value is
  // typed as AuthResponseDto. The DTO (and the service implementation) MUST
  // include a `refreshToken` field alongside `accessToken` and `expiresIn`.
  // The controller itself is already correct — it passes the full service
  // response through without stripping any fields.
  //
  // If your AuthResponseDto currently looks like:
  //   { accessToken: string; expiresIn: number; user: UserResponseDto }
  // add `refreshToken: string` to it, and make sure authService.login()
  // populates that field (typically by calling jwtService.sign() with a longer
  // TTL and a separate secret, then returning it here).
  //
  // Example AuthResponseDto addition:
  //   @ApiProperty() refreshToken: string;
  //
  // Example authService.login() return value:
  //   return {
  //     accessToken,
  //     refreshToken,   // <-- was missing
  //     expiresIn,
  //     user,
  //   };
  @Post('login')
  @RateLimit({ limit: 5, windowMs: 60_000, keyBy: 'ip' })
  @Public()
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto): Promise<AuthResponseDto> {
    // authService.login must now return { accessToken, refreshToken, expiresIn, user }
    return this.authService.login(loginDto);
  }

  @Post('register')
  @RateLimit({ limit: 5, windowMs: 60_000, keyBy: 'ip' })
  @Public()
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() registerDto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(registerDto);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req,
    @Body() logoutDto: LogoutDto,
  ): Promise<LogoutResponseDto> {
    return this.authService.logout(req.user, logoutDto);
  }

  @Post('refresh')
  @RateLimit({ limit: 10, windowMs: 60_000, keyBy: 'ip' })
  @Public()
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() refreshDto: RefreshDto): Promise<AuthResponseDto> {
    return this.authService.refreshTokens(refreshDto.refreshToken);
  }

  // ──────────────────────────── 2FA endpoints ────────────────────────────

  /** Step 1 of 2FA setup: returns a TOTP secret + QR code. */
  @Post('2fa/setup')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async setup2fa(@Req() req) {
    return this.twoFactorService.generateSetup(req.user);
  }

  /** Step 2 of 2FA setup: confirm a valid TOTP token to persist and enable 2FA. */
  @Post('2fa/enable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async enable2fa(
    @Req() req,
    @Body() dto: TwoFactorEnableDto,
  ): Promise<{ backupCodes: string[] }> {
    return this.twoFactorService.enable(req.user.id, dto.secret, dto.token);
  }

  /** Disable 2FA (requires a valid TOTP token for confirmation). */
  @Post('2fa/disable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async disable2fa(@Req() req, @Body() dto: TwoFactorTokenDto): Promise<void> {
    return this.twoFactorService.disable(req.user.id, dto.token);
  }

  /**
   * Complete login when 2FA is enabled.
   * Accepts the pre-auth token from the login response and a TOTP/backup token.
   */
  @Post('2fa/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  async verify2fa(@Body() dto: TwoFactorVerifyDto): Promise<AuthResponseDto> {
    return this.authService.verifyTwoFactor(dto.preAuthToken, dto.token);
  }

  /** Regenerate backup codes (requires a valid TOTP token). */
  @Post('2fa/backup-codes/regenerate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async regenerateBackupCodes(
    @Req() req,
    @Body() dto: TwoFactorTokenDto,
  ): Promise<{ backupCodes: string[] }> {
    return this.twoFactorService.regenerateBackupCodes(req.user.id, dto.token);
  }
}
