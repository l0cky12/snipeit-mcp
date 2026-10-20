import { isIPv4 } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { baseUrl, SnipeIT, type Row } from './snipeit.js';

export interface Config {
    url: string;
    token: string;
    readOnly: boolean;
}

export function configPath(): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(base, 'snipeit-mcp', 'config.json');
}

function readConfig(): Partial<Config> {
    let contents: string;
    try {
        contents = readFileSync(configPath(), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw new Error(`Cannot read config at ${configPath()}`);
    }
    try {
        const file = JSON.parse(contents);
        if (!file || typeof file !== 'object' || Array.isArray(file) ||
            (file.url !== undefined && typeof file.url !== 'string') ||
            (file.token !== undefined && typeof file.token !== 'string') ||
            (file.readOnly !== undefined && typeof file.readOnly !== 'boolean')) throw new Error();
        return file;
    } catch {
        throw new Error(`Invalid config at ${configPath()}: expected URL/token strings and a readOnly boolean`);
    }
}

function isPrivateHost(host: string): boolean {
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return true;
    if (!isIPv4(host)) return false;
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Validate the URL and refuse to send the token in cleartext beyond loopback/private LANs unless explicitly allowed. */
function checkUrl(url: string): void {
    const { protocol, hostname } = baseUrl(url);
    if (protocol !== 'http:' || isPrivateHost(hostname)) return;
    if (process.env.SNIPEIT_ALLOW_HTTP?.trim() !== '1') {
        throw new Error(`Refusing to send the Snipe-IT API token over plain http:// to ${hostname}. Use https://, or set SNIPEIT_ALLOW_HTTP=1 to accept the risk.`);
    }
    console.error(`WARNING: SNIPEIT_ALLOW_HTTP=1: the Snipe-IT API token is sent unencrypted to ${hostname}; anyone on the network path can read and reuse it.`);
}

/** Env vars win; the file written by `snipeit-mcp setup` is the fallback. */
export function loadConfig(): Config {
    const file = readConfig();
    const url = (process.env.SNIPEIT_URL || file.url)?.trim();
    const token = (process.env.SNIPEIT_API_TOKEN || file.token)?.trim();
    if (!url || !token) {
        throw new Error(
            `Snipe-IT URL/token not configured. Run \`snipeit-mcp setup\` or set SNIPEIT_URL and SNIPEIT_API_TOKEN.`
        );
    }
    const ro = process.env.SNIPEIT_READ_ONLY?.trim();
    if (ro !== undefined && !/^(1|true|yes|0|false|no)$/i.test(ro)) {
        throw new Error('SNIPEIT_READ_ONLY must be 1/true/yes or 0/false/no');
    }
    const readOnly = ro !== undefined ? /^(1|true|yes)$/i.test(ro) : Boolean(file.readOnly);
    checkUrl(url);
    return { url: url.replace(/\/+$/, ''), token, readOnly };
}

export async function setup(): Promise<void> {
    const previous = readConfig();
    // In terminal mode readline does its own echo through `output`, so muting it hides the token.
    let muted = false;
    const output = new Writable({
        write(chunk, _encoding, done) {
            if (!muted) process.stdout.write(chunk);
            done();
        }
    });
    const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
    try {
        const url = (await rl.question('Snipe-IT URL (e.g. https://snipeit.example.com): ')).trim().replace(/\/+$/, '');
        checkUrl(url);
        process.stdout.write('Personal API token (Account > API Keys in Snipe-IT, input hidden): ');
        muted = true;
        const token = (await rl.question('')).trim();
        muted = false;
        process.stdout.write('\nValidating... ');
        const me = (await new SnipeIT(url, token).get('users/me')) as Row;
        console.log(`ok, authenticated as ${me.username ?? me.name ?? 'unknown user'}`);
        const perms = (me.permissions ?? {}) as Row;
        if (String(perms.superuser) !== '1') {
            console.log(
                'WARNING: this token is not from a superuser account. The MCP server can only do what the token owner can do in the web UI.'
            );
        }
        const path = configPath();
        mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
        // Replace atomically: mode on writeFileSync alone does not secure an existing file.
        const temp = mkdtempSync(join(path, '..', '.config-'));
        try {
            const config = { url, token, ...(previous.readOnly === undefined ? {} : { readOnly: previous.readOnly }) };
            writeFileSync(join(temp, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
            renameSync(join(temp, 'config.json'), path);
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
        console.log(`Saved to ${path} (owner-only permissions).\n`);
        console.log('Add to Claude Code:\n  claude mcp add -s user snipeit -- npx -y snipeit-mcp\n');
        console.log('Add to OpenClaw:\n  openclaw mcp add snipeit --command npx --arg -y --arg snipeit-mcp');
        console.log('  (or in ~/.openclaw/openclaw.json: ' + JSON.stringify({ mcp: { servers: { snipeit: { command: 'npx', args: ['-y', 'snipeit-mcp'] } } } }) + ')');
        console.log('\nRead-only mode for less-trusted agents: set SNIPEIT_READ_ONLY=1 in that client\'s env.');
    } finally {
        rl.close();
    }
}
