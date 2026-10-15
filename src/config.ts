import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { SnipeIT } from './snipeit.js';

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
    return { url: url.replace(/\/+$/, ''), token, readOnly };
}

export async function setup(): Promise<void> {
    const previous = readConfig();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const url = (await rl.question('Snipe-IT URL (e.g. https://snipeit.example.com): ')).trim().replace(/\/+$/, '');
        const token = (await rl.question('Personal API token (Account > API Keys in Snipe-IT): ')).trim();
        process.stdout.write('Validating... ');
        const me = await new SnipeIT(url, token).get('users/me');
        console.log(`ok, authenticated as ${me.username ?? me.name ?? 'unknown user'}`);
        const perms = me.permissions ?? {};
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
