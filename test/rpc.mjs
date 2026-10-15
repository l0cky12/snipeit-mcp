// Tiny stdio JSON-RPC client so tests drive the real binary without extra deps.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function startServer(env = {}) {
    const proc = spawn(process.execPath, ['dist/index.js'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let nextId = 1;
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d));
    createInterface({ input: proc.stdout }).on('line', line => {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        const p = pending.get(msg.id);
        if (p) {
            pending.delete(msg.id);
            msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
    });
    const send = (method, params) =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    const init = async () => {
        const r = await send('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' }
        });
        notify('notifications/initialized', {});
        return r;
    };
    const call = async (name, args) => {
        const r = await send('tools/call', { name, arguments: args });
        const text = r.content?.[0]?.text ?? '';
        if (r.isError) throw new Error(text);
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    };
    const exited = new Promise(res => proc.on('exit', code => res({ code, stderr })));
    return { proc, send, init, call, exited, close: () => proc.kill() };
}
