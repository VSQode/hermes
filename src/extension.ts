/**
 * hermes v0.4.0 — Mid-stream and idle agent message injection
 *
 * Watches an inbox folder for .msg files and dispatches their content into
 * the VS Code Copilot Chat panel.
 *
 * Message format (UTF-8):
 *   {sessionId}|{mode}|{message}
 *
 * Modes:
 *   send          — dispatch when agent is idle (acceptInput).
 *   steer         — native steer: prefill input + steerWithMessage command.
 *                   VS Code (v1.110+) command: workbench.action.chat.steerWithMessage.
 *                   Blocked if context_pct > 95 (from context.probe file).
 *   stop-and-send — cancel + 300ms + send. Explicit cancel semantics.
 *   queue         — prefill input + queueMessage command (Alt+Enter equivalent).
 *                   VS Code (v1.110+) command: workbench.action.chat.queueMessage.
 *   compact       — opens context usage panel (workbench.action.chat.showContextUsage).
 *                   No programmatic compact command exists in VS Code (Feb 2026);
 *                   user must press compact button in the panel.
 *
 * Context probe file (optional):
 *   Written by qhoami extension to inbox/context.probe. Format:
 *     state: unknown|idle|running
 *     context_pct: 47
 *     patch: 10
 *     rsc: 42
 *     ts: 2026-02-20T13:20:38.533Z
 *   hermes reads this before dispatch to warn or block on high context pressure.
 *
 * File lifecycle:
 *   1. Caller writes:  inbox/{uuid}.msg  with content above
 *   2. This extension: dispatches message, then either:
 *      a. success → writes inbox/{uuid}.ack, deletes inbox/{uuid}.msg
 *      b. failure → writes inbox/{uuid}.err (reason string), deletes inbox/{uuid}.msg
 *      c. context warn → also writes inbox/{uuid}.warn (context warning), deletes .msg
 *
 * Implements VSQode/hermes#3 (Phase 3: queue mode + context awareness).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let watcher: vscode.FileSystemWatcher | undefined;

/** Promisified delay. */
const _delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Read the context probe file for pre-dispatch context awareness.
 * Written by qhoami extension to inbox/context.probe.
 * Returns null if file missing or unreadable.
 */
function _readContextProbe(inboxPath: string): { contextPct: number; patch: number; rsc: number; state: string } | null {
    try {
        const probeFile = path.join(inboxPath, 'context.probe');
        if (!fs.existsSync(probeFile)) return null;
        const content = fs.readFileSync(probeFile, 'utf-8');
        const parseNum = (key: string, def: number) => {
            const m = content.match(new RegExp(`^${key}:\\s*([\\d.]+)`, 'm'));
            return m ? parseFloat(m[1]) : def;
        };
        const parseStr = (key: string) => {
            const m = content.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'));
            return m ? m[1] : 'unknown';
        };
        return {
            contextPct: parseNum('context_pct', 0),
            patch: parseNum('patch', 0),
            rsc: parseNum('rsc', 0),
            state: parseStr('state'),
        };
    } catch {
        return null;
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[HERMES] Activated');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        console.error('[HERMES] No workspace root — inactive');
        return;
    }

    const inboxPath = path.join(workspaceRoot, '_', '.vscode', 'hermes-inbox');

    try {
        if (!fs.existsSync(inboxPath)) {
            fs.mkdirSync(inboxPath, { recursive: true });
        }
    } catch (err) {
        console.error('[HERMES] Failed to create inbox:', err);
    }

    const pattern = new vscode.RelativePattern(workspaceRoot, '_/.vscode/hermes-inbox/*.msg');
    watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate(async (uri) => {
        const msgFile = uri.fsPath;
        const basename = path.basename(msgFile, '.msg');
        const ackFile = path.join(path.dirname(msgFile), `${basename}.ack`);
        const errFile = path.join(path.dirname(msgFile), `${basename}.err`);
        const warnFile = path.join(path.dirname(msgFile), `${basename}.warn`);

        const _cleanup = (outFile: string, content: string) => {
            try { fs.writeFileSync(outFile, content, 'utf-8'); } catch {}
            try { fs.unlinkSync(msgFile); } catch {}
        };
        const _writeWarn = (content: string) => {
            try { fs.writeFileSync(warnFile, content, 'utf-8'); } catch {}
        };

        try {
            console.log('[HERMES] New message file:', msgFile);

            const raw = fs.readFileSync(msgFile, 'utf-8').trim();
            const parts = raw.split('|');

            if (parts.length < 3) {
                const reason = `Invalid format — expected "sessionId|mode|message", got ${parts.length} segment(s)`;
                console.error('[HERMES]', reason);
                _cleanup(errFile, reason);
                return;
            }

            const [sessionId, mode, ...messageParts] = parts;
            const message = messageParts.join('|');

            if (!sessionId || !mode || !message) {
                const reason = `Empty field — sessionId="${sessionId}" mode="${mode}" message="${message}"`;
                console.error('[HERMES]', reason);
                _cleanup(errFile, reason);
                return;
            }

            // Context probe check (written by qhoami extension).
            // Block steer at > 95% context fill; warn at > 80%.
            const probe = _readContextProbe(inboxPath);
            if (probe) {
                if (probe.contextPct > 95 && mode === 'steer') {
                    const reason = `mode=steer blocked: context_pct=${probe.contextPct}% > 95%. Use mode=compact first, then retry.`;
                    console.warn('[HERMES]', reason);
                    _cleanup(errFile, reason);
                    return;
                }
                if (probe.contextPct > 80) {
                    _writeWarn(`context warning: context_pct=${probe.contextPct}% > 80% (approaching compaction zone, patch=${probe.patch})`);
                    console.warn('[HERMES] Context warning: context_pct=%d%%', probe.contextPct);
                }
            }

            if (mode === 'send') {
                // Idle dispatch: opens chat panel and submits the message when the agent
                // is idle (send button available). Uses isPartialQuery=false which
                // internally calls acceptInput().
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: message,
                    isPartialQuery: false,
                });
                _cleanup(ackFile, `sent sessionId=${sessionId.substring(0, 8)}... at ${new Date().toISOString()}`);
                console.log('[HERMES] Sent (mode=send) to session', sessionId.substring(0, 8));
            } else if (mode === 'steer') {
                // Phase 2 (v0.3.0) was cancel+delay+send.
                // Phase 3 (v0.4.0): uses native steerWithMessage command (VS Code v1.110+).
                // Sequence: prefill input (isPartialQuery=true) → 100ms → steerWithMessage.
                // steerWithMessage interrupts the running agent and sends the new message.
                // When idle, behaves like a normal send.
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: message,
                    isPartialQuery: true,
                });
                await _delay(100);
                await vscode.commands.executeCommand('workbench.action.chat.steerWithMessage');
                const steerAck = `steered (steerWithMessage) sessionId=${sessionId.substring(0, 8)}... at ${new Date().toISOString()}`;
                _cleanup(ackFile, steerAck);
                console.log('[HERMES] Steered (mode=steer, steerWithMessage) to session', sessionId.substring(0, 8));
            } else if (mode === 'stop-and-send') {
                // Explicit cancel-then-send. Different from steer: explicitly cancels
                // first (300ms delay), then sends. Use when you want to guarantee
                // cancellation before the message is delivered.
                await vscode.commands.executeCommand('workbench.action.chat.cancel');
                await _delay(300);
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: message,
                    isPartialQuery: false,
                });
                const sasAck = `stop-and-send sessionId=${sessionId.substring(0, 8)}... at ${new Date().toISOString()}`;
                _cleanup(ackFile, sasAck);
                console.log('[HERMES] Stop-and-send to session', sessionId.substring(0, 8));
            } else if (mode === 'queue') {
                // Phase 3 (v0.4.0): uses native queueMessage command (VS Code v1.110+).
                // Sequence: prefill input (isPartialQuery=true) → 100ms → queueMessage.
                // queueMessage queues the current input for delivery after the agent
                // finishes its current request (Alt+Enter equivalent).
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: message,
                    isPartialQuery: true,
                });
                await _delay(100);
                await vscode.commands.executeCommand('workbench.action.chat.queueMessage');
                const queueAck = `queued (queueMessage) sessionId=${sessionId.substring(0, 8)}... at ${new Date().toISOString()}`;
                _cleanup(ackFile, queueAck);
                console.log('[HERMES] Queued (mode=queue, queueMessage) to session', sessionId.substring(0, 8));
            } else if (mode === 'compact') {
                // Phase 3 (v0.4.0): opens the context usage panel.
                // No programmatic compact-trigger command exists in VS Code (Feb 2026);
                // the panel shows a button for manual compaction.
                await vscode.commands.executeCommand('workbench.action.chat.showContextUsage');
                const compactAck = `compact: opened context usage panel at ${new Date().toISOString()}. No direct compact command in VS Code — press compact in the panel.`;
                _cleanup(ackFile, compactAck);
                console.log('[HERMES] Compact: opened context usage panel');
            } else {
                // Unknown mode — write .err, do not crash.
                const reason = `Unknown mode="${mode}" — supported modes: send, steer, stop-and-send, queue, compact`;
                console.error('[HERMES]', reason);
                _cleanup(errFile, reason);
            }
        } catch (error: any) {
            const reason = `Exception: ${error?.message ?? String(error)}`;
            console.error('[HERMES]', reason, error);
            _cleanup(errFile, reason);
        }
    });

    context.subscriptions.push(watcher);
    console.log('[HERMES] Watching:', inboxPath);
}

export function deactivate() {
    watcher?.dispose();
}
