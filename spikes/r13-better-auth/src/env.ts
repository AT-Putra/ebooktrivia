// DEV ONLY credentials from infra/dev/.env.example and infra/dev/valkey/users.acl.
export const PG = { host: "127.0.0.1", port: 55432, user: "postgres", password: "devonly" } as const;
export const VALKEY = { host: "127.0.0.1", port: 56379 } as const;
export const VALKEY_PUBLIC = { ...VALKEY, username: "public", password: "public-devonly" } as const;
export const BASE_URL = "http://localhost:3000";
export const SECRET = "spike-r13-secret-spike-r13-secret-0123456789";
export const OTP_PEPPER = "spike-r13-otp-pepper";
