import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Env vars win; the file written by `snipeit-mcp setup` is the fallback. */
export function loadConfig(): Config {
    let file: Partial<Config> = {};
    try {
        file = JSON.parse(readFileSync(configPath(), 'utf8'));
    } catch {
        /* no file yet */
    }
    const url = process.env.SNIPEIT_URL || file.url;
    const token = process.env.SNIPEIT_API_TOKEN || file.token;
    if (!url || !token) {
        throw new Error(
            `Snipe-IT URL/token not configured. Run \`snipeit-mcp setup\` or set SNIPEIT_URL and SNIPEIT_API_TOKEN.`
        );
    }
    const ro = process.env.SNIPEIT_READ_ONLY;
    const readOnly = ro !== undefined ? /^(1|true|yes)$/i.test(ro) : Boolean(file.readOnly);
    return { url: url.replace(/\/+$/, ''), token, readOnly };
}

export async function setup(): Promise<void> {
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
        writeFileSync(path, JSON.stringify({ url, token }, null, 2) + '\n', { mode: 0o600 });
        console.log(`Saved to ${path} (owner-only permissions).\n`);
        console.log('Add to Claude Code:\n  claude mcp add -s user snipeit -- npx -y snipeit-mcp\n');
        console.log('Add to OpenClaw:\n  openclaw mcp add snipeit --command npx --arg -y --arg snipeit-mcp');
        console.log('  (or in ~/.openclaw/openclaw.json: ' + JSON.stringify({ mcp: { servers: { snipeit: { command: 'npx', args: ['-y', 'snipeit-mcp'] } } } }) + ')');
        console.log('\nRead-only mode for less-trusted agents: set SNIPEIT_READ_ONLY=1 in that client\'s env.');
    } finally {
        rl.close();
    }
}
