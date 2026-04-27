import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtManagementService } from '../jwt/jwt-management.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtManagementService,
  ) {}

  async validateUser(email: string, password: string) {
    // Replace with real validation (DB + bcrypt)
    if (email !== 'test@example.com' || password !== 'password') {
      throw new UnauthorizedException('Invalid credentials');
    }

    return { id: 1, email };
  }

  async login(email: string, password: string) {
    const user = await this.validateUser(email, password);

    // ✅ Generate both tokens
    const accessToken = await this.jwtService.generateAccessToken(user);
    const refreshToken = await this.jwtService.generateRefreshToken(user);

    return {
      accessToken,
      refreshToken, // ✅ NOW RETURNED
    };
  }
}