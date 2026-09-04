// Asynchronous readiness assembler (PLAN M1.7 / M2): on plugin start, probe
// for `uv`, prepare the isolated Python environment, and — when a classifier
// bundle is configured — launch the C-tier classification service and wait
// for it to answer /health. The plugin is usable the moment it starts (the
// heuristic tier needs none of this); the assembler only reports status.
//
// Weights are never downloaded or bundled by this plugin: dev/testing point
// `classifier.bundleDir` at a locally installed OpenSquilla copy, and real
// users fetch a bundle from official channels.
// @module dsh-opensquilla/assembler
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function runCommand(bin, args, timeoutMs = 30_000) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(bin, args, { windowsHide: true });
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                child.kill();
                resolve({ code: null, stdout, stderr: stderr + '\n(assembler: command timed out)' });
            }
        }, timeoutMs);
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', (error) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ code: null, stdout, stderr: stderr + `\n${String(error)}` });
            }
        });
        child.on('close', (code) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({ code, stdout, stderr });
            }
        });
    });
}
async function healthOk(url, attempts) {
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
            if (response.ok)
                return true;
        }
        catch {
            // Not up yet.
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
}
/**
 * Background readiness assembler. `start()` returns immediately; state moves
 * `idle → probing → (uv-missing | env-ready → classifier-*)` and the latest
 * snapshot is readable at any time. Failure states are terminal for the
 * process lifetime; the heuristic tier is unaffected either way.
 * `dispose()` stops a launched classifier service.
 */
export class ReadinessAssembler {
    options;
    snapshot = { state: 'idle' };
    started = false;
    service;
    constructor(options = {}) {
        this.options = options;
    }
    get state() {
        return this.snapshot;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.snapshot = { state: 'probing' };
        void this.assemble().catch((error) => {
            this.snapshot = { state: 'env-failed', detail: String(error) };
        });
    }
    dispose() {
        if (this.service !== undefined && !this.service.killed) {
            this.service.kill();
        }
        this.service = undefined;
    }
    async assemble() {
        if (this.options.noop === true) {
            this.snapshot = { state: 'uv-missing', detail: 'assembler disabled (noop)' };
            return;
        }
        const envDir = this.options.envDir ?? await mkdtemp(join(tmpdir(), 'dsh-opensquilla-'));
        const classifier = this.options.classifier;
        // With an externally-supplied python we skip uv/env provisioning entirely;
        // otherwise create the isolated environment first.
        if (classifier?.python === undefined) {
            const uvBin = this.options.uvBin ?? 'uv';
            if (!existsSync(join(envDir, 'pyvenv.cfg'))) {
                const probe = await runCommand(uvBin, ['--version']);
                if (probe.code !== 0) {
                    this.snapshot = {
                        state: 'uv-missing',
                        detail: 'uv is not installed; the full ML classifier cannot be provisioned. Basic rule routing stays active.',
                    };
                    return;
                }
                const venv = await runCommand(uvBin, ['venv', envDir, '--python', '3.12']);
                if (venv.code !== 0) {
                    this.snapshot = { state: 'env-failed', detail: `uv venv failed: ${venv.stderr.trim().slice(0, 400)}` };
                    return;
                }
            }
        }
        this.snapshot = { state: 'env-ready', envDir };
        // Launch + gate the C-tier service when a bundle is configured.
        if (classifier === undefined)
            return;
        this.snapshot = { state: 'classifier-starting', envDir };
        const python = classifier.python ?? join(envDir, 'Scripts', 'python.exe');
        const service = spawn(python, [
            classifier.entry,
            '--bundle-dir', classifier.bundleDir,
            '--port', String(classifier.port),
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        this.service = service;
        service.stderr?.on('data', (_chunk) => { });
        const ok = await healthOk(classifier.url, this.options.healthAttempts ?? 20);
        if (ok) {
            this.snapshot = { state: 'classifier-ready', envDir };
        }
        else {
            this.snapshot = {
                state: 'classifier-failed',
                envDir,
                detail: `classifier service at ${classifier.url} did not become healthy`,
            };
        }
    }
}
