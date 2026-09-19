/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BedrockConverseProvider } from './converseProvider';
import { getAgentFilePatterns } from './discovery';

export function activate(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel('Bedrock Agents', { log: true });
	const provider = new BedrockConverseProvider(message => channel.info(message));

	const patternWatchers: vscode.FileSystemWatcher[] = [];
	const disposePatternWatchers = () => {
		for (const watcher of patternWatchers.splice(0)) {
			watcher.dispose();
		}
	};
	const rebuildPatternWatchers = () => {
		disposePatternWatchers();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			for (const pattern of getAgentFilePatterns(folder)) {
				if (path.isAbsolute(pattern)) {
					// Files outside the workspace cannot be watched through the
					// workspace API; they are re-read on every model query.
					continue;
				}
				try {
					const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
					watcher.onDidCreate(() => provider.refresh());
					watcher.onDidChange(() => provider.refresh());
					watcher.onDidDelete(() => provider.refresh());
					patternWatchers.push(watcher);
				} catch {
					// Invalid patterns are reported during discovery.
				}
			}
		}
	};
	rebuildPatternWatchers();

	context.subscriptions.push(
		channel,
		vscode.lm.registerLanguageModelChatProvider('bedrock', provider),
		new vscode.Disposable(disposePatternWatchers),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('bedrockAgents.agentFiles')) {
				rebuildPatternWatchers();
				provider.refresh();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			rebuildPatternWatchers();
			provider.refresh();
		}),
	);
}

export function deactivate(): void {
	// Everything is cleaned up through the extension context subscriptions.
}
