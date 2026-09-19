/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { ContentBlock, ConverseStreamCommandInput, DocumentFormat, ImageFormat, InferenceConfiguration, Message, SystemContentBlock, ToolConfiguration, ToolResultContentBlock, ToolUseBlock } from '@aws-sdk/client-bedrock-runtime';
import * as vscode from 'vscode';
import type { BedrockAgentDefinition } from './agentFile';

/** Smithy document type used for JSON payloads in the Converse API. */
type DocumentType = NonNullable<ConverseStreamCommandInput['additionalModelRequestFields']>;

/**
 * Metadata keys used to round-trip complete reasoning blocks through
 * {@link vscode.LanguageModelThinkingPart.metadata}. The incremental thinking
 * parts only carry deltas; the final part carries the complete block so it can
 * be replayed into the next request's history. Same convention as the
 * Anthropic BYOK provider (`_completeThinking` / `signature`).
 */
export const enum ThinkingMetadataKeys {
	CompleteThinking = '_completeThinking',
	Signature = 'signature',
	/** Base64-encoded `redactedContent` bytes of a redacted reasoning block. */
	RedactedContent = 'redactedContent',
}

function mimeToImageFormat(mimeType: string): ImageFormat | undefined {
	switch (mimeType) {
		case 'image/png': return 'png';
		case 'image/jpeg': return 'jpeg';
		case 'image/gif': return 'gif';
		case 'image/webp': return 'webp';
		default: return undefined;
	}
}

function dataPartToConverseBlock(part: vscode.LanguageModelDataPart): ContentBlock | undefined {
	const imageFormat = mimeToImageFormat(part.mimeType);
	if (imageFormat) {
		return { image: { format: imageFormat, source: { bytes: part.data } } };
	}
	if (part.mimeType === 'application/pdf') {
		return { document: { format: 'pdf' satisfies DocumentFormat, name: 'document', source: { bytes: part.data } } };
	}
	return undefined;
}

function thinkingPartToConverseBlock(part: vscode.LanguageModelThinkingPart): ContentBlock | undefined {
	const redacted = part.metadata?.[ThinkingMetadataKeys.RedactedContent];
	if (typeof redacted === 'string' && redacted.length > 0) {
		return { reasoningContent: { redactedContent: Buffer.from(redacted, 'base64') } };
	}
	const completeThinking = part.metadata?.[ThinkingMetadataKeys.CompleteThinking];
	if (typeof completeThinking === 'string' && completeThinking.length > 0) {
		const signature = part.metadata?.[ThinkingMetadataKeys.Signature];
		return {
			reasoningContent: {
				reasoningText: {
					text: completeThinking,
					...(typeof signature === 'string' && signature.length > 0 ? { signature } : {}),
				}
			}
		};
	}
	// Incremental thinking deltas are not replayed into history.
	return undefined;
}

function toolResultToConverseBlock(part: vscode.LanguageModelToolResultPart): ContentBlock {
	const content: ToolResultContentBlock[] = [];
	for (const subPart of part.content) {
		if (subPart instanceof vscode.LanguageModelTextPart) {
			if (subPart.value.length > 0) {
				content.push({ text: subPart.value });
			}
		} else if (subPart instanceof vscode.LanguageModelDataPart) {
			const block = dataPartToConverseBlock(subPart);
			if (block?.image) {
				content.push({ image: block.image });
			} else if (block?.document) {
				content.push({ document: block.document });
			}
		}
	}
	if (content.length === 0) {
		content.push({ text: ' ' });
	}
	return { toolResult: { toolUseId: part.callId, content } };
}

function apiContentToConverseContent(content: ReadonlyArray<unknown>): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			if (part.value.length > 0) {
				blocks.push({ text: part.value });
			}
		} else if (part instanceof vscode.LanguageModelThinkingPart) {
			const block = thinkingPartToConverseBlock(part);
			if (block) {
				blocks.push(block);
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			blocks.push({ toolUse: { toolUseId: part.callId, name: part.name, input: part.input as ToolUseBlock['input'] } });
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			blocks.push(toolResultToConverseBlock(part));
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const block = dataPartToConverseBlock(part);
			if (block) {
				blocks.push(block);
			}
		}
	}
	return blocks;
}

/**
 * Convert editor request messages to Converse messages, merging adjacent
 * same-role messages (Converse requires strict user/assistant alternation).
 */
export function apiMessagesToConverseMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Message[] {
	const unmerged: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> = [];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const content = apiContentToConverseContent(message.content);
		if (content.length === 0) {
			content.push({ text: ' ' });
		}
		unmerged.push({ role, content });
	}

	const merged: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> = [];
	for (const message of unmerged) {
		const previous = merged.at(-1);
		if (previous && previous.role === message.role) {
			previous.content.push(...message.content);
		} else {
			merged.push({ role: message.role, content: [...message.content] });
		}
	}
	return merged;
}

export function systemToConverseBlocks(system: readonly string[] | undefined): SystemContentBlock[] | undefined {
	if (!system || system.length === 0) {
		return undefined;
	}
	return system.map(text => ({ text }));
}

/**
 * Build the Converse inference configuration for a request. `topK` has no
 * slot in the Converse `InferenceConfiguration` shape, so it is routed into
 * `additionalModelRequestFields`, where models that support it expect it.
 * Per-model user configuration (validated against the agent's
 * `configurationSchema`) overrides the agent file values; unrecognized keys
 * are passed through as additional model request fields.
 */
export function buildInferenceOptions(
	definition: BedrockAgentDefinition,
	modelConfiguration: { readonly [key: string]: unknown } | undefined,
): { inferenceConfig?: InferenceConfiguration; additionalModelRequestFields?: ConverseStreamCommandInput['additionalModelRequestFields'] } {
	const merged = { ...definition.inferenceConfig };
	const additional: Record<string, unknown> = { ...definition.additionalModelRequestFields };

	if (modelConfiguration) {
		for (const [key, value] of Object.entries(modelConfiguration)) {
			switch (key) {
				case 'maxTokens':
				case 'temperature':
				case 'topP':
				case 'topK':
				case 'stopSequences':
					(merged as Record<string, unknown>)[key] = value;
					break;
				default:
					additional[key] = value;
			}
		}
	}

	const inferenceConfig: InferenceConfiguration = {};
	if (typeof merged.maxTokens === 'number') {
		inferenceConfig.maxTokens = merged.maxTokens;
	}
	if (typeof merged.temperature === 'number') {
		inferenceConfig.temperature = merged.temperature;
	}
	if (typeof merged.topP === 'number') {
		inferenceConfig.topP = merged.topP;
	}
	if (Array.isArray(merged.stopSequences) && merged.stopSequences.length > 0) {
		inferenceConfig.stopSequences = [...merged.stopSequences];
	}
	if (typeof merged.topK === 'number') {
		additional['topK'] = merged.topK;
	}

	return {
		...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
		...(Object.keys(additional).length > 0 ? { additionalModelRequestFields: additional as ConverseStreamCommandInput['additionalModelRequestFields'] } : {}),
	};
}

export function toolsToConverseToolConfig(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
	toolMode: vscode.LanguageModelChatToolMode,
): ToolConfiguration | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return {
		tools: tools.map(tool => ({
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: { json: (tool.inputSchema ?? { type: 'object', properties: {} }) as DocumentType },
			}
		})),
		toolChoice: toolMode === vscode.LanguageModelChatToolMode.Required ? { any: {} } : { auto: {} },
	};
}
