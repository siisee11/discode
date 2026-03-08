import { parseRuntimeWindowId } from './window-id.js';

export const RUNTIME_STREAM_PROTOCOL_VERSION = 1;
export const RUNTIME_STREAM_PROTOCOL_MIN_SUPPORTED_VERSION = 1;
export const RUNTIME_STREAM_PROTOCOL_MAX_SUPPORTED_VERSION = 2;
export const RUNTIME_CONTROL_PROTOCOL_VERSION = 1;

export type RuntimeStreamInbound =
  | { type: 'hello'; clientId?: string; version?: number }
  | { type: 'subscribe'; windowId: string; cols?: number; rows?: number }
  | { type: 'focus'; windowId: string }
  | { type: 'input'; windowId: string; bytesBase64: string }
  | { type: 'resize'; windowId: string; cols: number; rows: number }
  | { type: 'ping'; id?: string };

export type RuntimeStreamInboundValidationErrorCode =
  | 'bad_message'
  | 'unknown_type'
  | 'bad_subscribe'
  | 'bad_focus'
  | 'bad_input'
  | 'bad_resize';

export type RuntimeStreamInboundValidationResult =
  | { ok: true; message: RuntimeStreamInbound }
  | { ok: false; code: RuntimeStreamInboundValidationErrorCode; message: string };

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value;
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed)) return parsed;
  }
  return undefined;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return parseInteger(value);
}

function parseWindowId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (!parseRuntimeWindowId(value)) return undefined;
  return value;
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0) return false;
  if (value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value;
}

export function parseRuntimeStreamProtocolVersion(value: unknown): number | undefined {
  return parseInteger(value);
}

export function isSupportedRuntimeStreamProtocolVersion(version: number): boolean {
  return (
    Number.isInteger(version)
    && version >= RUNTIME_STREAM_PROTOCOL_MIN_SUPPORTED_VERSION
    && version <= RUNTIME_STREAM_PROTOCOL_MAX_SUPPORTED_VERSION
  );
}

export function validateRuntimeStreamInboundMessage(value: unknown): RuntimeStreamInboundValidationResult {
  const message = asObject(value);
  if (!message) {
    return { ok: false, code: 'bad_message', message: 'Invalid message' };
  }

  const type = message.type;
  if (typeof type !== 'string' || type.length === 0) {
    return { ok: false, code: 'bad_message', message: 'Invalid message' };
  }

  switch (type) {
    case 'hello': {
      const version = parseOptionalInteger(message.version);
      if (message.version !== undefined && version === undefined) {
        return { ok: false, code: 'bad_message', message: 'Invalid hello.version' };
      }
      const clientId = typeof message.clientId === 'string' && message.clientId.length > 0
        ? message.clientId
        : undefined;
      return {
        ok: true,
        message: {
          type: 'hello',
          version,
          clientId,
        },
      };
    }

    case 'subscribe': {
      const windowId = parseWindowId(message.windowId);
      if (!windowId) {
        return { ok: false, code: 'bad_subscribe', message: 'Invalid windowId' };
      }
      const cols = parseOptionalInteger(message.cols);
      if (message.cols !== undefined && cols === undefined) {
        return { ok: false, code: 'bad_subscribe', message: 'Invalid cols' };
      }
      const rows = parseOptionalInteger(message.rows);
      if (message.rows !== undefined && rows === undefined) {
        return { ok: false, code: 'bad_subscribe', message: 'Invalid rows' };
      }
      return {
        ok: true,
        message: {
          type: 'subscribe',
          windowId,
          cols,
          rows,
        },
      };
    }

    case 'focus': {
      const windowId = parseWindowId(message.windowId);
      if (!windowId) {
        return { ok: false, code: 'bad_focus', message: 'Invalid windowId' };
      }
      return {
        ok: true,
        message: {
          type: 'focus',
          windowId,
        },
      };
    }

    case 'input': {
      const windowId = parseWindowId(message.windowId);
      if (!windowId) {
        return { ok: false, code: 'bad_input', message: 'Invalid windowId' };
      }
      if (typeof message.bytesBase64 !== 'string' || !isStrictBase64(message.bytesBase64)) {
        return { ok: false, code: 'bad_input', message: 'Invalid bytesBase64' };
      }
      return {
        ok: true,
        message: {
          type: 'input',
          windowId,
          bytesBase64: message.bytesBase64,
        },
      };
    }

    case 'resize': {
      const windowId = parseWindowId(message.windowId);
      if (!windowId) {
        return { ok: false, code: 'bad_resize', message: 'Invalid windowId' };
      }
      const cols = parseInteger(message.cols);
      const rows = parseInteger(message.rows);
      if (cols === undefined || rows === undefined || cols <= 0 || rows <= 0) {
        return { ok: false, code: 'bad_resize', message: 'Invalid size' };
      }
      return {
        ok: true,
        message: {
          type: 'resize',
          windowId,
          cols,
          rows,
        },
      };
    }

    case 'ping': {
      if (message.id !== undefined && typeof message.id !== 'string') {
        return { ok: false, code: 'bad_message', message: 'Invalid ping.id' };
      }
      return {
        ok: true,
        message: {
          type: 'ping',
          id: message.id,
        },
      };
    }

    default:
      return { ok: false, code: 'unknown_type', message: 'Unknown message type' };
  }
}
