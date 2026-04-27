import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';

class LoginDto {
  email: string;
  password: string;
}

class AuthResponseDto {
  accessToken: string;
  refreshToken: string; // ✅ ADDED
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() loginDto: LoginDto): Promise<AuthResponseDto> {
    const result = await this.authService.login(
      loginDto.email,
      loginDto.password,
    );

    return result; // now includes refreshToken
  }
}