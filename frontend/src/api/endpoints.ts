import {
  ActivityItem,
  ApiError,
  AuthResponse,
  Certificate,
  CertificateTemplate,
  CreateCertificateData,
  DashboardStats,
  IssuanceTrendPoint,
  PaginatedResponse,
  CertificateExportFilters,
  StatusDistribution,
  User,
  UserRole,
  VerificationResult,
  LoginCredentials,
  RegisterData,
  ProfileUpdateData,
  DailyVerificationStats,
  TotalCertificatesStats,
  TotalActiveUsersStats,
  IssuerStats,
  PaginatedActivityLog,
  CertificateTransfer,
  InitiateTransferDto,
  ApproveTransferDto,
  RejectTransferDto,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
} from "./types";
import { tokenStorage } from "./tokens";

interface AuditLogQueryParams {
  action?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

// Configuration flag - can be enabled via Vite env `VITE_USE_DUMMY_DATA` ("true"/"false") in development only.
const viteEnv = import.meta as unknown as { env: Record<string, string> };
const USE_DUMMY_DATA =
  viteEnv.env?.VITE_USE_DUMMY_DATA === "true" &&
  viteEnv.env?.MODE !== "production";
const API_URL_BASE = viteEnv.env?.VITE_API_URL || "http://localhost:3000/api/v1";
export const API_URL = API_URL_BASE;

// Helper function to simulate API delay
const simulateDelay = () => new Promise((resolve) => setTimeout(resolve, 300));

// Common error handler
const handleError = (error: unknown, endpointName: string): never => {
  console.error(`Error in ${endpointName}:`, error);
  const apiError: ApiError = {
    message:
      error instanceof Error ? error.message : "An unexpected error occurred",
    statusCode:
      error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode: number }).statusCode
        : 500,
    error:
      error && typeof error === "object" && "name" in error
        ? (error as { name: string }).name
        : "API Error",
  };
  throw apiError;
};

/**
 * Sleep utility for retry delays
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Refresh tokens using the stored refresh token
 */
const refreshTokens = async (): Promise<AuthResponse> => {
  const refreshToken = tokenStorage.getRefreshToken();
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }
  return apiClient<AuthResponse>('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
    skipAuth: true,
  });
};

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
  retryCondition?: (error: any) => boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  baseDelay: 300,
  maxDelay: 2000,
  backoffFactor: 2,
  retryCondition: (error) => {
    // Retry on network errors and 5xx server errors
    return !error.statusCode || (error.statusCode >= 500 && error.statusCode < 600);
  }
};

/**
 * Standardized API client for all requests with retry logic
 */
export async function apiClient<T>(
  endpoint: string,
  options: RequestInit & { skipAuth?: boolean } = {},
  retryConfig: Partial<RetryConfig> = {},
): Promise<T> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  const url = `${API_URL}${endpoint}`;
  const isGetRequest = !options.method || options.method.toUpperCase() === 'GET';

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  if (!options.skipAuth) {
    const token = tokenStorage.getAccessToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const attemptRequest = async (attempt: number, hasTriedRefresh: boolean = false): Promise<T> => {
    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorData: ApiError = await response.json().catch(() => ({
          message: response.statusText || "API request failed",
          statusCode: response.status,
        }));

        if (response.status === 401 && !hasTriedRefresh) {
          try {
            const refreshResponse = await refreshTokens();
            tokenStorage.setAccessToken(refreshResponse.accessToken);
            tokenStorage.setRefreshToken(refreshResponse.refreshToken);
            // Retry the original request with hasTriedRefresh = true
            return attemptRequest(attempt, true);
          } catch (refreshError) {
            tokenStorage.clearTokens();
            throw errorData;
          }
        } else if (response.status === 401) {
          tokenStorage.clearTokens();
          throw errorData;
        }

        throw errorData;
      }

      if (response.status === 204) {
        return {} as T;
      }

      return await response.json();
    } catch (error) {
      // Don't retry if this is the last attempt or retry condition is not met
      if (attempt >= config.maxRetries || !config.retryCondition?.(error)) {
        if ((error as ApiError).statusCode) {
          throw error;
        }

        const apiError: ApiError = {
          message:
            error instanceof Error ? error.message : "An unexpected error occurred",
          statusCode: 0,
          error: "Network Error",
        };
        throw apiError;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        config.baseDelay * Math.pow(config.backoffFactor, attempt - 1),
        config.maxDelay
      );

      console.warn(`API request failed (attempt ${attempt}/${config.maxRetries + 1}), retrying in ${delay}ms:`, error);

      await sleep(delay);
      return attemptRequest(attempt + 1, hasTriedRefresh);
    }
  };

  // Only apply retry logic to GET requests by default
  if (isGetRequest) {
    return attemptRequest(1, false);
  } else {
    // For non-GET requests, make a single attempt
    return attemptRequest(config.maxRetries + 1, false);
  }
}

// Dummy data generators
const dummyData = {
  users: [
    {
      id: "1",
      email: "john@example.com",
      firstName: "John",
      lastName: "Doe",
      role: UserRole.ISSUER,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "2",
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Smith",
      role: UserRole.RECIPIENT,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ] as User[],

  certificates: [
    {
      id: "cert-1",
      serialNumber: "CERT-2023-001",
      recipientName: "John Doe",
      recipientEmail: "john@example.com",
      issueDate: new Date().toISOString(),
      expiryDate: new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      issuerName: "StellarCert Academy",
      status: "active",
      title: "Blockchain Expert",
      courseName: "Stellar Fundamentals",
    },
    {
      id: "cert-2",
      serialNumber: "CERT-2023-002",
      recipientName: "Jane Smith",
      recipientEmail: "jane@example.com",
      issueDate: new Date().toISOString(),
      expiryDate: new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      issuerName: "StellarCert Academy",
      status: "revoked",
      title: "Web3 Developer",
      courseName: "Smart Contract Development",
    },
  ] as Certificate[],

  templates: [
    {
      id: "template-default",
      name: "Default Template",
      description: "Standard academic certificate template",
      layoutUrl: "/templates/default.pdf",
      fields: ["name", "date", "course"],
      issuerId: "1",
    },
  ] as CertificateTemplate[],
};

// ==================== USER MANAGEMENT ====================

export const fetchUserByEmail = async (email: string): Promise<User | null> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const user = dummyData.users.find((user) => user.email === email);
    console.log("Dummy User Data:", user);
    return user || null;
  }

  try {
    return await apiClient<User | null>(`/users/email/${email}`);
  } catch (error) {
    return handleError(error, "fetchUserByEmail");
  }
};

export const userApi = {
  getProfile: async (): Promise<User> => {
    return apiClient<User>("/users/profile");
  },
  updateProfile: async (data: ProfileUpdateData): Promise<User> => {
    return apiClient<User>("/users/profile", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },
  getByEmail: fetchUserByEmail,
  listAll: async (
    params?: Record<string, string | number | boolean>,
  ): Promise<PaginatedResponse<User>> => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        searchParams.append(key, String(value));
      });
    }
    return apiClient<PaginatedResponse<User>>(
      `/users?${searchParams.toString()}`,
    );
  },
  getAll: async (params?: Record<string, string | number | boolean>) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        searchParams.set(key, String(value));
      });
    }
    return apiClient<PaginatedResponse<User>>(`/users?${searchParams.toString()}`);
  },
  getById: async (id: string) => apiClient<User>(`/users/${id}`),
  updateRole: async (id: string, role: string) =>
    apiClient<User>(`/users/${id}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  toggleStatus: async (id: string, isActive: boolean) =>
    apiClient<User>(`/users/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ isActive }),
    }),
  delete: async (id: string) => apiClient<void>(`/users/${id}`, { method: "DELETE" }),
};

// ==================== TEMPLATE MANAGEMENT ====================

export const fetchDefaultTemplate = async (): Promise<CertificateTemplate> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const template = dummyData.templates[0];
    console.log("Dummy Template Data:", template);
    return template;
  }

  try {
    return await apiClient<CertificateTemplate>("/templates/default");
  } catch (error) {
    return handleError(error, "fetchDefaultTemplate");
  }
};

export const templateApi = {
  list: async (): Promise<CertificateTemplate[]> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return dummyData.templates;
    }
    return apiClient<CertificateTemplate[]>("/templates");
  },
  getDefaultTemplate: fetchDefaultTemplate,
};

// ==================== CERTIFICATE MANAGEMENT ====================

export const verifyCertificate = async (
  serialNumber: string,
): Promise<VerificationResult> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const certificate = dummyData.certificates.find(
      (cert) => cert.serialNumber === serialNumber,
    );
    const result: VerificationResult = certificate
      ? {
          isValid: certificate.status === "active",
          status: certificate.status === "active" ? "valid" : "revoked",
          certificate,
          verificationDate: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          message:
            certificate.status === "active"
              ? "Certificate is valid and active"
              : "Certificate has been revoked.",
          verificationId: `ver_${Date.now()}`,
        }
      : {
          isValid: false,
          status: "not_found",
          verificationDate: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          message: "Certificate not found",
          verificationId: `ver_${Date.now()}`,
        };
    console.log("Dummy Verification:", result);
    return result;
  }

  try {
    return await apiClient<VerificationResult>(
      `/certificates/${serialNumber}/verify`,
    );
  } catch (error) {
    return handleError(error, "verifyCertificate");
  }
};

export const createCertificate = async (
  data: CreateCertificateData,
): Promise<Certificate> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const newCertificate: Certificate = {
      id: `cert-${Date.now()}`,
      serialNumber: `CERT-${new Date().getFullYear()}-${Math.floor(
        Math.random() * 1000,
      )
        .toString()
        .padStart(3, "0")}`,
      recipientName: data.recipientName,
      recipientEmail: data.recipientEmail,
      title: "New Certificate",
      courseName: data.courseName,
      issuerName: "StellarCert Academy",
      issueDate: new Date().toISOString(),
      status: "active",
    };
    dummyData.certificates.push(newCertificate);
    console.log("Dummy certificate created:", newCertificate);
    return newCertificate;
  }

  try {
    return await apiClient<Certificate>("/certificates", {
      method: "POST",
      body: JSON.stringify(data),
    });
  } catch (error) {
    return handleError(error, "createCertificate");
  }
};

export const revokeCertificate = async (
  id: string,
  reason: string,
): Promise<Certificate> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const certificate = dummyData.certificates.find((cert) => cert.id === id);
    if (certificate) {
      certificate.status = "revoked";
      console.log("Dummy certificate revoked:", certificate);
      return certificate;
    }
    throw new Error("Certificate not found");
  }

  try {
    return await apiClient<Certificate>(`/certificates/${id}/revoke`, {
      method: "PATCH",
      body: JSON.stringify({ reason }),
    });
  } catch (error) {
    return handleError(error, "revokeCertificate");
  }
};

export const findCertBySerialNumber = async (
  serialNumber: string,
): Promise<Certificate | null> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const certificate = dummyData.certificates.find(
      (cert) => cert.serialNumber === serialNumber,
    );
    console.log("Dummy Certificate:", certificate);
    return certificate || null;
  }

  try {
    return await apiClient<Certificate | null>(
      `/certificates/serial/${serialNumber}`,
    );
  } catch (error) {
    return handleError(error, "findCertBySerialNumber");
  }
};

export const getCertificatePdfUrl = async (
  certificateId: string,
): Promise<string | null> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const certificate = dummyData.certificates.find(
      (cert) => cert.id === certificateId,
    );
    return certificate ? `/api/dummy-pdf/${certificateId}` : null;
  }

  try {
    const data = await apiClient<{ pdfUrl: string }>(
      `/certificates/${certificateId}/pdf`,
    );
    return data.pdfUrl;
  } catch (error) {
    return handleError(error, "getCertificatePdfUrl");
  }
};

export const getUserCertificates = async (
  userId: string,
): Promise<Certificate[]> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    return dummyData.certificates.filter(
      (cert) => cert.recipientEmail === userId || cert.id === userId,
    );
  }

  try {
    return await apiClient<Certificate[]>(`/certificates/user/${userId}`);
  } catch (error) {
    return handleError(error, "getUserCertificates");
  }
};

export const getCertificateQR = async (
  certificateId: string,
): Promise<string> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    // Return a dummy QR code URL
    return `data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjBmMGYwIi8+CiAgPHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIxNCIgZmlsbD0iIzMzMyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkJJIENvZGU6ICR7Y2VydGlmaWNhdGVJZH08L3RleHQ+Cjwvc3ZnPg==`;
  }

  try {
    const data = await apiClient<{ qrCode: string }>(
      `/certificates/${certificateId}/qr`,
    );
    return data.qrCode;
  } catch (error) {
    return handleError(error, "getCertificateQR");
  }
};

export const certificateApi = {
  list: async (params?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    startDate?: string;
    endDate?: string;
  }): Promise<PaginatedResponse<Certificate>> => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== "") {
          searchParams.append(key, String(value));
        }
      });
    }
    return apiClient<PaginatedResponse<Certificate>>(
      `/certificates?${searchParams.toString()}`,
    );
  },
  create: createCertificate,
  verify: verifyCertificate,
  revoke: revokeCertificate,
  getById: async (id: string): Promise<Certificate> => {
    return apiClient<Certificate>(`/certificates/${id}`);
  },
  getAll: async (
    params?: Record<string, string | number | boolean>,
  ): Promise<PaginatedResponse<Certificate> | Certificate[]> => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        searchParams.set(key, String(value));
      });
    }

    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return {
        data: dummyData.certificates,
        certificates: dummyData.certificates,
        total: dummyData.certificates.length,
        page: 1,
        limit: dummyData.certificates.length,
        totalPages: 1,
      } as PaginatedResponse<Certificate> & { certificates: Certificate[] };
    }

    return apiClient<PaginatedResponse<Certificate>>(
      `/certificates?${searchParams.toString()}`,
    );
  },
  getUserCertificates,
  bulkExport: async (
    certificateIds: string[],
    filters?: CertificateExportFilters,
  ): Promise<Blob> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      const headers = [
        "ID",
        "Recipient Name",
        "Email",
        "Title",
        "Status",
        "Issue Date",
      ];
      const normalizedSearch = filters?.search?.trim().toLowerCase();
      const startDate = filters?.startDate ? new Date(filters.startDate) : null;
      const endDate = filters?.endDate ? new Date(filters.endDate) : null;
      const certs = dummyData.certificates.filter((certificate) => {
        const matchesIds =
          certificateIds.length === 0 ||
          certificateIds.includes(certificate.id);
        const matchesSearch =
          !normalizedSearch ||
          [
            certificate.id,
            certificate.serialNumber,
            certificate.recipientName,
            certificate.recipientEmail,
            certificate.title,
            certificate.issuerName,
          ].some((value) => value?.toLowerCase().includes(normalizedSearch));
        const matchesStatus =
          !filters?.status || certificate.status === filters.status;
        const issueDate = new Date(certificate.issueDate);
        const matchesStartDate = !startDate || issueDate >= startDate;
        const matchesEndDate = !endDate || issueDate <= endDate;

        return (
          matchesIds &&
          matchesSearch &&
          matchesStatus &&
          matchesStartDate &&
          matchesEndDate
        );
      });
      const rows = certs.map((c) => [
        c.id,
        c.recipientName,
        c.recipientEmail,
        c.title,
        c.status,
        c.issueDate,
      ]);
      const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");
      return new Blob([csv], { type: "text/csv" });
    }
    const response = await fetch(`${API_URL}/certificates/export`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenStorage.getAccessToken()}`,
      },
      body: JSON.stringify({ certificateIds, filters }),
    });
    if (!response.ok) throw new Error("Export failed");
    return response.blob();
  },
  bulkExportAll: async (filters?: CertificateExportFilters): Promise<Blob> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      const headers = [
        "ID",
        "Recipient Name",
        "Email",
        "Title",
        "Status",
        "Issue Date",
      ];
      const normalizedSearch = filters?.search?.trim().toLowerCase();
      const startDate = filters?.startDate ? new Date(filters.startDate) : null;
      const endDate = filters?.endDate ? new Date(filters.endDate) : null;
      const certs = dummyData.certificates.filter((certificate) => {
        const matchesSearch =
          !normalizedSearch ||
          [
            certificate.id,
            certificate.serialNumber,
            certificate.recipientName,
            certificate.recipientEmail,
            certificate.title,
            certificate.issuerName,
          ].some((value) => value?.toLowerCase().includes(normalizedSearch));
        const matchesStatus =
          !filters?.status || certificate.status === filters.status;
        const issueDate = new Date(certificate.issueDate);
        const matchesStartDate = !startDate || issueDate >= startDate;
        const matchesEndDate = !endDate || issueDate <= endDate;

        return (
          matchesSearch && matchesStatus && matchesStartDate && matchesEndDate
        );
      });
      const rows = certs.map((c) => [
        c.id,
        c.recipientName,
        c.recipientEmail,
        c.title,
        c.status,
        c.issueDate,
      ]);
      const csv = [headers, ...rows].map((row) => row.join(",")).join("\n");
      return new Blob([csv], { type: "text/csv" });
    }

    const response = await fetch(`${API_URL}/certificates/export/all`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenStorage.getAccessToken()}`,
      },
      body: JSON.stringify({ filters }),
    });
    if (!response.ok) {
      throw new Error("Export failed");
    }
    return response.blob();
  },
  bulkRevoke: async (
    certificateIds: string[],
    reason?: string,
  ): Promise<Certificate[]> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      const updatedCerts: Certificate[] = [];
      for (const id of certificateIds) {
        const cert = dummyData.certificates.find((certificate) => certificate.id === id);
        if (cert) {
          cert.status = "revoked";
          updatedCerts.push(cert);
        }
      }
      return updatedCerts;
    }

    return apiClient<Certificate[]>("/certificates/bulk-revoke", {
      method: "POST",
      body: JSON.stringify({ certificateIds, reason }),
    });
  },
  freeze: async (
    certificateId: string,
    reason: string,
    durationDays: number,
  ): Promise<Certificate> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      const cert = dummyData.certificates.find((certificate) => certificate.id === certificateId);
      if (!cert) {
        throw new Error("Certificate not found");
      }

      cert.status = "frozen";
      cert.freezeReason = reason;
      cert.frozenAt = new Date().toISOString();
      const unfreezeDate = new Date();
      unfreezeDate.setDate(unfreezeDate.getDate() + durationDays);
      cert.unfreezeAt = unfreezeDate.toISOString();
      return cert;
    }

    return apiClient<Certificate>(`/certificates/${certificateId}/freeze`, {
      method: "POST",
      body: JSON.stringify({ reason, durationDays }),
    });
  },
  unfreeze: async (certificateId: string): Promise<Certificate> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      const cert = dummyData.certificates.find((certificate) => certificate.id === certificateId);
      if (!cert) {
        throw new Error("Certificate not found");
      }

      cert.status = "active";
      cert.freezeReason = undefined;
      cert.frozenAt = undefined;
      cert.unfreezeAt = undefined;
      return cert;
    }

    return apiClient<Certificate>(`/certificates/${certificateId}/unfreeze`, {
      method: "POST",
    });
  },
  getQR: getCertificateQR,
  
  // Certificate Transfer API (#286)
  transfer: {
    initiate: async (data: InitiateTransferDto): Promise<CertificateTransfer> => {
      return apiClient("/certificates/transfers/initiate", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    approve: async (data: ApproveTransferDto): Promise<CertificateTransfer> => {
      return apiClient("/certificates/transfers/approve", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    reject: async (data: RejectTransferDto): Promise<CertificateTransfer> => {
      return apiClient("/certificates/transfers/reject", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    getPending: async (): Promise<CertificateTransfer[]> => {
      return apiClient("/certificates/transfers/pending");
    },
  }
};

// ==================== AUTHENTICATION ====================

export const loginApi = async (
  credentials: LoginCredentials,
): Promise<AuthResponse> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const user = dummyData.users.find((u) => u.email === credentials.email);
    if (user && credentials.password === "password123") {
      const response: AuthResponse = {
        user,
        accessToken: "dummy-access-token",
        refreshToken: "dummy-refresh-token",
      };
      tokenStorage.setAccessToken(response.accessToken);
      // Note: refreshToken is handled server-side via httpOnly cookies
      return response;
    }
    throw new Error("Invalid credentials");
  }

  try {
    const response = await apiClient<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    });
    tokenStorage.setAccessToken(response.accessToken);
    // Note: refreshToken is handled server-side via httpOnly cookies
    return response;
  } catch (error) {
    return handleError(error, "loginApi");
  }
};

export const registerApi = async (
  data: RegisterData,
): Promise<AuthResponse> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    const newUser: User = {
      id: `user-${Date.now()}`,
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    dummyData.users.push(newUser);
    const response: AuthResponse = {
      user: newUser,
      accessToken: "dummy-access-token",
      refreshToken: "dummy-refresh-token",
    };
    tokenStorage.setAccessToken(response.accessToken);
    // Note: refreshToken is handled server-side via httpOnly cookies
    return response;
  }

  try {
    const response = await apiClient<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
    tokenStorage.setAccessToken(response.accessToken);
    // Note: refreshToken is handled server-side via httpOnly cookies
    return response;
  } catch (error) {
    return handleError(error, "registerApi");
  }
};

export const authApi = {
  login: loginApi,
  register: registerApi,
  refresh: async (): Promise<AuthResponse> => {
    const refreshToken = tokenStorage.getRefreshToken();
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }
    return apiClient<AuthResponse>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      skipAuth: true,
    });
  },
  logout: async (): Promise<void> => {
    try {
      if (!USE_DUMMY_DATA) {
        await apiClient("/auth/logout", { method: "POST" });
      }
    } finally {
      tokenStorage.clearTokens();
    }
  },
  forgotPassword: async (data: ForgotPasswordRequest): Promise<{ message: string }> => {
    return apiClient("/users/forgot-password", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  resetPassword: async (data: ResetPasswordRequest): Promise<{ message: string }> => {
    return apiClient("/users/reset-password", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  verifyEmail: async (
    data: VerifyEmailRequest,
  ): Promise<{ message: string }> => {
    return apiClient("/users/verify-email", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
};

export const login = loginApi;
export const register = registerApi;

type CertificateStatsResponse = {
  totalCertificates: number;
  activeCertificates: number;
  revokedCertificates: number;
  expiredCertificates: number;
  issuanceTrend: IssuanceTrendPoint[];
  verificationStats: {
    totalVerifications: number;
    successfulVerifications: number;
    failedVerifications: number;
    dailyVerifications: number;
    weeklyVerifications: number;
  };
};

const buildStatusDistributionFromCertificates = (
  certificates: Certificate[],
): StatusDistribution => {
  const base: StatusDistribution = {
    active: 0,
    revoked: 0,
    expired: 0,
  };

  for (const cert of certificates) {
    if (cert.status === "active") {
      base.active += 1;
    } else if (cert.status === "revoked") {
      base.revoked += 1;
    } else if (cert.status === "expired") {
      base.expired += 1;
    }
  }

  return base;
};

const buildIssuanceTrendFromCertificates = (
  certificates: Certificate[],
): IssuanceTrendPoint[] =>
  Array.from(
    certificates.reduce((map, cert) => {
      const dateKey = cert.issueDate.slice(0, 10);
      map.set(dateKey, (map.get(dateKey) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
  )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

const buildRecentActivityFromCertificates = (
  certificates: Certificate[],
): ActivityItem[] =>
  certificates
    .map((cert) => ({
      type: (cert.status === "revoked" ? "revoke" : "issue") as ActivityItem["type"],
      date: cert.issueDate,
      description:
        cert.status === "revoked"
          ? `Revoked ${cert.title} for ${cert.recipientName}`
          : `Issued ${cert.title} to ${cert.recipientName}`,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

export const dailyCertificateVerification =
  async (): Promise<DailyVerificationStats> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return { count: Math.floor(Math.random() * 50) + 20 };
    }
    return apiClient<DailyVerificationStats>(
      "/certificates/stats/daily-verification",
    );
  };

export const totalCertificates = async (): Promise<TotalCertificatesStats> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    return { total: dummyData.certificates.length };
  }
  return apiClient<TotalCertificatesStats>("/certificates/stats/total");
};

export const totalActiveUsers = async (): Promise<TotalActiveUsersStats> => {
  if (USE_DUMMY_DATA) {
    await simulateDelay();
    return { total: dummyData.users.length };
  }
  return apiClient<TotalActiveUsersStats>("/users/stats/active");
};

export const analyticsApi = {
  getDashboardSummary: async (params?: {
    startDate?: string;
    endDate?: string;
    issuerId?: string;
  }): Promise<DashboardStats> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();

      let certificates = dummyData.certificates;
      if (params?.startDate && params?.endDate) {
        const start = new Date(params.startDate);
        const end = new Date(params.endDate);
        certificates = certificates.filter((cert) => {
          const issuedAt = new Date(cert.issueDate);
          return issuedAt >= start && issuedAt <= end;
        });
      }

      const statusDistribution =
        buildStatusDistributionFromCertificates(certificates);

      return {
        totalCertificates: certificates.length,
        activeCertificates: statusDistribution.active,
        revokedCertificates: statusDistribution.revoked,
        expiredCertificates: statusDistribution.expired,
        totalVerifications: 1250,
        verifications24h: 45,
        totalUsers: dummyData.users.length,
        issuanceTrend: buildIssuanceTrendFromCertificates(certificates),
        statusDistribution,
        recentActivity: buildRecentActivityFromCertificates(certificates),
      };
    }

    const searchParams = new URLSearchParams();
    if (params?.startDate) searchParams.set("startDate", params.startDate);
    if (params?.endDate) searchParams.set("endDate", params.endDate);
    if (params?.issuerId) searchParams.set("issuerId", params.issuerId);
    const query = searchParams.toString();

    const data = await apiClient<CertificateStatsResponse>(
      `/certificates/stats${query ? `?${query}` : ""}`,
    );

    return {
      totalCertificates: data.totalCertificates,
      activeCertificates: data.activeCertificates,
      revokedCertificates: data.revokedCertificates,
      expiredCertificates: data.expiredCertificates,
      totalVerifications: data.verificationStats.totalVerifications,
      verifications24h: data.verificationStats.dailyVerifications,
      totalUsers: 0,
      issuanceTrend: data.issuanceTrend,
      statusDistribution: {
        active: data.activeCertificates,
        revoked: data.revokedCertificates,
        expired: data.expiredCertificates,
      },
      recentActivity: [],
    };
  },
};

export const adminAnalyticsApi = {
  getAnalytics: async (params?: {
    startDate?: string;
    endDate?: string;
  }): Promise<import("./types").AdminAnalytics> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return {
        usersByRole: {
          users: 42,
          issuers: 12,
          admins: 3,
          total: dummyData.users.length,
        },
        usersByStatus: {
          active: dummyData.users.length,
          inactive: 0,
          suspended: 0,
          pendingVerification: 0,
        },
        certificatesByStatus: {
          active: dummyData.certificates.filter((cert) => cert.status === "active").length,
          revoked: dummyData.certificates.filter((cert) => cert.status === "revoked").length,
          expired: dummyData.certificates.filter((cert) => cert.status === "expired").length,
          total: dummyData.certificates.length,
        },
        topIssuers: [
          {
            issuerId: "issuer-1",
            issuerName: "StellarCert Academy",
            certificateCount: dummyData.certificates.length,
            percentage: 100,
          },
        ],
        verificationTrends: {
          total: 1200,
          successful: 1140,
          failed: 60,
          successRate: 95,
          last24Hours: 45,
          last7Days: 210,
          last30Days: 830,
        },
        userRegistrationTrend: [
          { date: params?.startDate ?? new Date().toISOString().slice(0, 10), count: 2 },
        ],
        certificateIssuanceTrend: buildIssuanceTrendFromCertificates(
          dummyData.certificates,
        ),
        totalIssuers: 12,
      };
    }

    const searchParams = new URLSearchParams();
    if (params?.startDate) searchParams.set("startDate", params.startDate);
    if (params?.endDate) searchParams.set("endDate", params.endDate);
    return apiClient(`/admin/analytics?${searchParams.toString()}`);
  },
};

export const issuerProfileApi = {
  getStats: async (): Promise<IssuerStats> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return {
        totalCertificates: 125,
        activeCertificates: 118,
        revokedCertificates: 7,
        expiredCertificates: 0,
        totalVerifications: 2847,
        lastLogin: new Date().toISOString(),
      };
    }
    return apiClient<IssuerStats>("/users/profile/stats");
  },
  getActivity: async (
    page: number = 1,
    limit: number = 10,
  ): Promise<PaginatedActivityLog> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      const activities = [
        {
          id: "1",
          action: "ISSUE_CERTIFICATE",
          description: 'Issued "Blockchain Fundamentals" certificate to Alice Johnson',
          ipAddress: "192.168.1.100",
          userAgent: "Mozilla/5.0",
          timestamp: new Date().toISOString(),
        },
      ];
      return {
        activities,
        meta: {
          total: activities.length,
          page,
          limit,
          totalPages: 1,
        },
      };
    }
    return apiClient<PaginatedActivityLog>(
      `/users/profile/activity?page=${page}&limit=${limit}`,
    );
  },
  updateProfile: async (data: ProfileUpdateData): Promise<User> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return dummyData.users[0];
    }
    return apiClient<User>("/users/profile/issuer", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  },
  uploadProfilePicture: async (
    file: File,
  ): Promise<{ profilePicture: string; message: string }> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return {
        profilePicture: URL.createObjectURL(file),
        message: "Profile picture uploaded successfully",
      };
    }

    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`${API_URL}/users/profile/picture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenStorage.getAccessToken() ?? ""}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorData: ApiError = await response.json().catch(() => ({
        message: response.statusText || "Profile picture upload failed",
        statusCode: response.status,
      }));
      throw errorData;
    }

    return response.json();
  },
};

// ==================== DASHBOARD & ANALYTICS ====================

export const dashboardApi = {
  getStats: async (): Promise<DashboardStats> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return {
        totalCertificates: 1250,
        activeCertificates: 1200,
        revokedCertificates: 30,
        expiredCertificates: 20,
        issuanceTrend: [
          { date: "2023-01", count: 100 },
          { date: "2023-02", count: 120 },
          { date: "2023-03", count: 150 },
        ],
        totalVerifications: 450,
        verifications24h: 15,
        totalUsers: 1150,
        statusDistribution: {
          active: 1200,
          revoked: 30,
          expired: 20
        },
        recentActivity: [
          {
            type: "issue",
            date: new Date().toISOString(),
            description: "Issued certificate 'Blockchain Expert' to John Doe",
          },
        ],
      };
    }
    return apiClient<DashboardStats>("/admin/analytics/dashboard");
  },

  getRecentActivity: async (limit = 10): Promise<ActivityItem[]> => {
    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return [
        {
          type: "issue",
          date: new Date().toISOString(),
          description: "Issued certificate 'Blockchain Expert' to John Doe",
        },
      ];
    }
    return apiClient<ActivityItem[]>(`/admin/analytics/activity?limit=${limit}`);
  },
};

// ==================== AUDIT LOGS (#283) ====================

export const auditApi = {
  getLogs: async (params?: AuditLogQueryParams): Promise<PaginatedActivityLog> => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value) searchParams.append(key, String(value));
      });
    }
    return apiClient<PaginatedActivityLog>(`/audit?${searchParams.toString()}`);
  },
  getCertificateHistory: async (certificateId: string): Promise<ActivityItem[]> => {
    return apiClient<ActivityItem[]>(`/audit/resource/CERTIFICATE/${certificateId}`);
  },
  searchLogs: async (
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<import("./types").AuditLogSearchResponse> => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== "") {
          searchParams.set(key, String(value));
        }
      });
    }

    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return {
        data: [
          {
            id: "audit-1",
            action: "ISSUE_CERTIFICATE",
            description: "Issued Blockchain Fundamentals to Alice Johnson",
            timestamp: new Date().toISOString(),
            ipAddress: "127.0.0.1",
          },
        ],
        total: 1,
      };
    }

    return apiClient(`/audit/search?${searchParams.toString()}`);
  },
  getStatistics: async (
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<import("./types").AuditStatistics> => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== "") {
          searchParams.set(key, String(value));
        }
      });
    }

    if (USE_DUMMY_DATA) {
      await simulateDelay();
      return {
        total: 1,
        byAction: {
          ISSUE_CERTIFICATE: 1,
        },
      };
    }

    return apiClient(`/audit/statistics?${searchParams.toString()}`);
  },
  exportCsvUrl: (
    params?: Record<string, string | number | boolean | undefined>,
  ) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== "") {
          searchParams.set(key, String(value));
        }
      });
    }
    const query = searchParams.toString();
    return `${API_URL}/audit/export${query ? `?${query}` : ""}`;
  },
};
