/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseAgentFile, type BedrockAgentDefinition } from './agentFile';

export const DEFAULT_AGENT_FILE_PATTERNS = ['.vscode/bedrock-agents/*.json'];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The agent file patterns configured for a workspace folder
 * (relative glob patterns or absolute file paths).
 */
export function getAgentFilePatterns(folder: vscode.WorkspaceFolder): string[] {
	const configured = vscode.workspace.getConfiguration('bedrockAgents', folder).get<string[]>('agentFiles', DEFAULT_AGENT_FILE_PATTERNS);
	return configured.length > 0 ? configured : DEFAULT_AGENT_FILE_PATTERNS;
}

/**
 * Discover and parse all agent definition files across workspace folders.
 * Invalid files and duplicate ids are skipped and logged; they never throw.
 */
export async function discoverAgentFiles(log: (message: string) => void): Promise<BedrockAgentDefinition[]> {
	const definitions: BedrockAgentDefinition[] = [];
	const seenIds = new Map<string, string>();

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const seenFiles = new Set<string>();
		const files: vscode.Uri[] = [];
		for (const pattern of getAgentFilePatterns(folder)) {
			if (path.isAbsolute(pattern)) {
				const uri = vscode.Uri.file(pattern);
				if (!seenFiles.has(uri.toString())) {
					seenFiles.add(uri.toString());
					files.push(uri);
				}
				continue;
			}
			try {
				for (const uri of await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern))) {
					if (!seenFiles.has(uri.toString())) {
						seenFiles.add(uri.toString());
						files.push(uri);
					}
				}
			} catch (error) {
				log(`Invalid agent file pattern "${pattern}": ${errorMessage(error)}`);
			}
		}

		for (const uri of files) {
			let content: string;
			try {
				content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			} catch (error) {
				log(`Failed to read agent file ${uri.fsPath}: ${errorMessage(error)}`);
				continue;
			}
			const result = parseAgentFile(content, uri.fsPath);
			if (result.errors) {
				log(`Skipping agent file ${uri.fsPath}: ${result.errors.join('; ')}`);
				continue;
			}
			const existing = seenIds.get(result.definition.id);
			if (existing) {
				log(`Skipping duplicate agent id "${result.definition.id}" in ${uri.fsPath} (already defined in ${existing})`);
				continue;
			}
			seenIds.set(result.definition.id, uri.fsPath);
			definitions.push(result.definition);
		}
	}

	return definitions;
}
