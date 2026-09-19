/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compile-time shim for the `ChatLocation` reference inside
 * `vscode.proposed.chatProvider.d.ts` (its real declaration lives in
 * `vscode.proposed.chatParticipantPrivate.d.ts`, which would drag in a chain
 * of unrelated proposed types). Values mirror the real enum. Remove this file
 * once `chatProvider` no longer references `ChatLocation` or this extension
 * starts including `chatParticipantPrivate`.
 */
declare module 'vscode' {
	export enum ChatLocation {
		Panel = 1,
		Terminal = 2,
		Notebook = 3,
		Editor = 4,
	}
}
