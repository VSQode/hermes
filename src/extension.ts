import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let watcher: vscode.FileSystemWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('[HERMES] Activated');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

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
        try {
            console.log('[HERMES] New message file:', uri.fsPath);
            
            const content = fs.readFileSync(uri.fsPath, 'utf-8').trim();
            const parts = content.split('|');
            const sessionId = parts[0];
            const mode = parts[1] || 'send';
            const message = parts.slice(2).join('|');

            if (!sessionId || !message) {
                console.error('[HERMES] Invalid format:', content);
                return;
            }

            if (mode === 'send') {
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: message,
                    isPartialQuery: false
                });
                fs.writeFileSync(`${uri.fsPath}.ack`, 'Message sent successfully');
            } else if (mode === 'steer') {
                await vscode.commands.executeCommand('workbench.action.chat.steerWithMessage', {
                    query: message
                });
                fs.writeFileSync(`${uri.fsPath}.ack`, 'Message steered successfully');
            } else {
                fs.writeFileSync(`${uri.fsPath}.err`, 'queue mode not yet implemented');
            }

            fs.unlinkSync(uri.fsPath);
            console.log('[HERMES] Processed message for session', sessionId.substring(0, 8));

        } catch (error) {
            console.error('[HERMES] Failed:', error);
            fs.writeFileSync(`${uri.fsPath}.err`, error.message);
        }
    });

    context.subscriptions.push(watcher);
    console.log('[HERMES] Watching:', inboxPath);
}

export function deactivate() {
    watcher?.dispose();
}