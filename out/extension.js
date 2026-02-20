"use strict";
/**
 * hermes v0.3.0 — Mid-stream and idle agent message injection
 *
 * Watches an inbox folder for .msg files and dispatches their content into
 * the VS Code Copilot Chat panel.
 *
 * Message format (UTF-8):
 *   {sessionId}|{mode}|{message}
 *
 * Modes:
 *   send          — dispatch when agent is idle (acceptInput, silently fails if running).
 *   steer         — cancel any running request then send. Safe no-op when idle.
 *                   VS Code source (Feb 2026) has no steer/queue command, so best-effort:
 *                   cancel (no-op if idle) + 250ms + send.
 *   stop-and-send — explicit cancel + 300ms + send. Same semantics as steer.
 *   queue         — reserved for Phase 3 (queued dispatch).
 *
 * File lifecycle:
 *   1. Caller writes:  inbox/{uuid}.msg  with content above
 *   2. This extension: dispatches message, then either:
 *      a. success → writes inbox/{uuid}.ack, deletes inbox/{uuid}.msg
 *      b. failure → writes inbox/{uuid}.err (reason string), deletes inbox/{uuid}.msg
 *
 * Implements VSQode/hermes#2 (Phase 2: steer mode + stop-and-send).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
let watcher;
/** Promisified delay. */
const _delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function activate(context) {
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
    }
    catch (err) {
        console.error('[HERMES] Failed to create inbox:', err);
    }
    const pattern = new vscode.RelativePattern(workspaceRoot, '_/.vscode/hermes-inbox/*.msg');
    watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(async (uri) => {
        const msgFile = uri.fsPath;
        const basename = path.basename(msgFile, '.msg');
        const ackFile = path.join(path.dirname(msgFile), `${basename}.ack`);
        const errFile = path.join(path.dirname(msgFile), `${basename}.err`);
        const _cleanup = (outFile, content) => {
            try {
                fs.writeFileSync(outFile, content, 'utf-8');
            }
            catch { }
            try {
                fs.unlinkSync(msgFile);
            }
            catch { }
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
            }
            else if (mode === 'steer') {
                // Phase 2: cancel any in-progress request + wait + send.
                // VS Code (Feb 2026) has no native steer/queue command.
                // CancelAction calls cancelCurrentRequestForSession — safe no-op when idle.
                // workbench.action.chat.open with isPartialQuery=false calls acceptInput();
                // it returns void when running, so cancel first guarantees delivery.
                await vscode.commands.executeCommand('workbench.action.chat.cancel');
                await _delay(250);
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: message,
                    isPartialQuery: false,
                });
                const steerAck = `steered (cancel+250ms+send) sessionId=${sessionId.substring(0, 8)}... at ${new Date().toISOString()}`;
                _cleanup(ackFile, steerAck);
                console.log('[HERMES] Steered (mode=steer) to session', sessionId.substring(0, 8));
            }
            else if (mode === 'stop-and-send') {
                // Explicit cancel-then-send. Same as steer but with a longer delay
                // (300ms) and unambiguous naming for callers that want to be explicit.
                await vscode.commands.executeCommand('workbench.action.chat.cancel');
                await _delay(300);
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: message,
                    isPartialQuery: false,
                });
                const sasAck = `stop-and-send sessionId=${sessionId.substring(0, 8)}... at ${new Date().toISOString()}`;
                _cleanup(ackFile, sasAck);
                console.log('[HERMES] Stop-and-send to session', sessionId.substring(0, 8));
            }
            else if (mode === 'queue') {
                // Phase 3: queued dispatch — not yet implemented.
                const reason = 'mode=queue: not implemented (Phase 3)';
                console.warn('[HERMES]', reason);
                _cleanup(errFile, reason);
            }
            else {
                // Unknown mode — write .err, do not crash.
                const reason = `Unknown mode="${mode}" — supported modes: send, steer, stop-and-send, queue (Phase 3)`;
                console.error('[HERMES]', reason);
                _cleanup(errFile, reason);
            }
        }
        catch (error) {
            const reason = `Exception: ${error?.message ?? String(error)}`;
            console.error('[HERMES]', reason, error);
            _cleanup(errFile, reason);
        }
    });
    context.subscriptions.push(watcher);
    console.log('[HERMES] Watching:', inboxPath);
}
function deactivate() {
    watcher?.dispose();
}
//# sourceMappingURL=extension.js.map