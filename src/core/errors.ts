/**
 * Custom error classes for acp-client-prototype
 */

export class AcpError extends Error {
  constructor(
    message: string,
    public readonly code?: string | number,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AgentSpawnError extends AcpError {
  constructor(message: string, data?: unknown) {
    super(message, "AGENT_SPAWN_ERROR", data);
  }
}

export class AuthError extends AcpError {
  constructor(message: string, data?: unknown) {
    super(message, "AUTH_ERROR", data);
  }
}

export class SessionError extends AcpError {
  constructor(message: string, data?: unknown) {
    super(message, "SESSION_ERROR", data);
  }
}

export class ConfigurationError extends AcpError {
  constructor(message: string, data?: unknown) {
    super(message, "CONFIGURATION_ERROR", data);
  }
}

export class PermissionDeniedError extends AcpError {
  constructor(message: string, data?: unknown) {
    super(message, "PERMISSION_DENIED", data);
  }
}

export class TransportError extends AcpError {
  constructor(message: string, data?: unknown) {
    super(message, "TRANSPORT_ERROR", data);
  }
}

export class PtyError extends AcpError {
  constructor(message: string, data?: unknown) {
    super(message, "PTY_ERROR", data);
  }
}
