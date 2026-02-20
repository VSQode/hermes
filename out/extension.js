"use strict";
/**
 * hermes v0.2.0 — Mid-stream and idle agent message injection
 *
 * Watches an inbox folder for .msg files and dispatches their content into
 * the VS Code Copilot Chat panel.
 *
 * Message format (UTF-8):
 *   {sessionId}|{mode}|{message}
 *
 * Modes:
 *   send   — dispatch when agent is idle (send button available). Same as v0.1.0.
 *            Writes {basename}.ack on success; {basename}.err on failure.
 *   steer  — reserved for Phase 2 (mid-stream steering).
 *   queue  — reserved for Phase 3 (queued dispatch).
 *
 * File lifecycle:
 *   1. Caller writes:  inbox/{uuid}.msg  with content above
 *   2. This extension: dispatches message, then either:
 *      a. success → writes inbox/{uuid}.ack, deletes inbox/{uuid}.msg
 *      b. failure → writes inbox/{uuid}.err (reason string), deletes inbox/{uuid}.msg
 *
 * Implements VSQode/hermes#1 (Phase 1: adopt VGM9 prototype, establish baseline).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
let watcher;
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
                // Phase 2: mid-stream steering — not yet implemented.
                const reason = 'mode=steer: not implemented (Phase 2)';
                console.warn('[HERMES]', reason);
                _cleanup(errFile, reason);
            }
            else if (mode === 'queue') {
                // Phase 3: queued dispatch — not yet implemented.
                const reason = 'mode=queue: not implemented (Phase 3)';
                console.warn('[HERMES]', reason);
                _cleanup(errFile, reason);
            }
            else {
                // Unknown mode — write .err, do not crash.
                const reason = `Unknown mode="${mode}" — supported modes: send, steer (Phase 2), queue (Phase 3)`;
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