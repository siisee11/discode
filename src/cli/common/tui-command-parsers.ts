export type ParsedNewCommand = {
  projectName?: string;
  agentName?: string;
  attach: boolean;
  instanceId?: string;
  projectPath?: string;
};

function splitCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\') {
      const next = raw[i + 1];
      if (next && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) {
        escaping = true;
        continue;
      }
      current += ch;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaping) {
    current += '\\';
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function parseNewCommand(raw: string): ParsedNewCommand {
  const parts = splitCommand(raw);
  let attach = false;
  let instanceId: string | undefined;
  let projectPath: string | undefined;
  const values: string[] = [];

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '--attach') {
      attach = true;
      continue;
    }
    if (part === '--instance' && parts[i + 1]) {
      instanceId = parts[i + 1];
      i += 1;
      continue;
    }
    if (part.startsWith('--instance=')) {
      const value = part.slice('--instance='.length).trim();
      if (value) instanceId = value;
      continue;
    }
    if (part === '--path' && parts[i + 1]) {
      projectPath = parts[i + 1];
      i += 1;
      continue;
    }
    if (part.startsWith('--path=')) {
      const value = part.slice('--path='.length).trim();
      if (value) projectPath = value;
      continue;
    }
    if (part.startsWith('--')) continue;
    values.push(part);
  }

  const projectName = values[0];
  const agentName = values[1];
  return {
    projectName,
    agentName,
    attach,
    instanceId,
    projectPath,
  };
}

export type ParsedOnboardCommand = {
  options: {
    platform?: 'discord' | 'slack';
    runtimeMode?: 'pty-rust';
    token?: string;
    slackBotToken?: string;
    slackAppToken?: string;
    defaultAgentCli?: string;
    telemetryEnabled?: boolean;
    opencodePermissionMode?: 'allow' | 'default';
  };
  showUsage?: boolean;
  error?: string;
};

export function parseOnboardCommand(raw: string): ParsedOnboardCommand {
  const parts = raw.split(/\s+/).filter(Boolean);
  const options: ParsedOnboardCommand['options'] = {};
  const toBoolean = (value: string): boolean | undefined => {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'on' || lowered === 'true' || lowered === '1' || lowered === 'yes' || lowered === 'y') return true;
    if (lowered === 'off' || lowered === 'false' || lowered === '0' || lowered === 'no' || lowered === 'n') return false;
    return undefined;
  };

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '--help' || part === '-h') {
      return { options, showUsage: true };
    }

    const eqIndex = part.indexOf('=');
    const flag = eqIndex >= 0 ? part.slice(0, eqIndex) : part;
    const inlineValue = eqIndex >= 0 ? part.slice(eqIndex + 1) : undefined;
    const readValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = parts[i + 1];
      if (!next || next.startsWith('--')) return undefined;
      i += 1;
      return next;
    };

    if (!part.startsWith('--')) {
      if (!options.platform && (part === 'discord' || part === 'slack')) {
        options.platform = part;
        continue;
      }
      return { options, error: `Unknown option: ${part}` };
    }

    if (flag === '--platform') {
      const value = (readValue() || '').toLowerCase();
      if (value !== 'discord' && value !== 'slack') {
        return { options, error: 'platform must be discord or slack.' };
      }
      options.platform = value;
      continue;
    }

    if (flag === '--runtime-mode') {
      const value = (readValue() || '').toLowerCase();
      if (value !== 'pty-rust') {
        return { options, error: 'runtime mode must be pty-rust.' };
      }
      options.runtimeMode = 'pty-rust';
      continue;
    }

    if (flag === '--token') {
      const value = readValue();
      if (!value) return { options, error: 'token requires a value.' };
      options.token = value;
      continue;
    }

    if (flag === '--slack-bot-token') {
      const value = readValue();
      if (!value) return { options, error: 'slack-bot-token requires a value.' };
      options.slackBotToken = value;
      continue;
    }

    if (flag === '--slack-app-token') {
      const value = readValue();
      if (!value) return { options, error: 'slack-app-token requires a value.' };
      options.slackAppToken = value;
      continue;
    }

    if (flag === '--default-agent') {
      const value = readValue();
      if (!value) return { options, error: 'default-agent requires a value.' };
      options.defaultAgentCli = value;
      continue;
    }

    if (flag === '--telemetry') {
      const value = readValue();
      if (!value) return { options, error: 'telemetry requires a value (on/off).' };
      const telemetryEnabled = toBoolean(value);
      if (telemetryEnabled === undefined) {
        return { options, error: 'telemetry must be on/off/true/false.' };
      }
      options.telemetryEnabled = telemetryEnabled;
      continue;
    }

    if (flag === '--opencode-permission') {
      const value = (readValue() || '').toLowerCase();
      if (value !== 'allow' && value !== 'default') {
        return { options, error: 'opencode-permission must be allow or default.' };
      }
      options.opencodePermissionMode = value;
      continue;
    }

    return { options, error: `Unknown option: ${flag}` };
  }

  return { options };
}
