# jiborobot/srv-security-gw:src/errors/account.ts

export const ACCESS_KEY_NOT_FOUND = {
  code: "ACCESS_KEY_NOT_FOUND",
  message: "Access key not found",
  statusCode: 401,
};
export const ACCOUNT_NOT_ACTIVE = {
  code: "ACCOUNT_NOT_ACTIVE",
  message: "Account not active",
  statusCode: 403,
};
export const MISSING_AUTH_HEADER = {
  code: "MISSING_AUTH_HEADER",
  message: "Request is not signed properly, missing authorization header",
  statusCode: 401,
};
export const MISSING_DATE_HEADER = {
  code: "MISSING_DATE_HEADER",
  message: "Request must contain Date or X-Amz-Date header",
  statusCode: 401,
};
export const MISSING_ENCRYPTION_ALGORITHM = {
  code: "MISSING_ENCRYPTION_ALGORITHM",
  message: "Request is not signed properly, encryption algorithm not specified",
  statusCode: 401,
};
export const SIGNATURE_MISMATCH = {
  code: "SIGNATURE_MISMATCH",
  message: "Signature does not match",
  statusCode: 401,
};
export const ACCOUNT_SERVICE_UNAVAILABLE = {
  code: "ACCOUNT_SERVICE_UNAVAILABLE",
  message: "Account service not found",
  statusCode: 503,
};
export const CLOCK_SKEW_TOO_LONG = {
  code: "CLOCK_SKEW_TOO_LONG",
  message: "Clock skew is more than 15 minutes",
  statusCode: 401,
};
export const MAINTENANCE_MODE = {
  code: "MAINTENANCE_MODE",
  message: "Maintenance in progress",
  statusCode: 503,
};
