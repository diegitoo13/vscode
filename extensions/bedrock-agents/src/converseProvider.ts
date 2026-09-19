/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ConverseStreamCommand, type ConverseStreamCommandInput } from '@aws-sdk/client-bedrock-runtime';
import * as vscode from 'vscode';
import type { BedrockAgentDefinition } from './agentFile';
import { getBedrockClient, resolveRegion, type BedrockProviderConfiguration } from './awsClient';
import { discoverAgentFiles } from './discovery';
import { ThinkingMetadataKeys, apiMessagesToConverseMessages, buildInferenceOptions, systemToConverseBlocks, toolsToConverseToolConfig } from './messageConverter';

/** MIME type convention used across the chat stack to carry token usage. */
const USAGE_MIME_TYPE = 'usage';

export interface BedrockModelInformation extends vscode.LanguageModelChatInformation {
	readonly definition: BedrockAgentDefinition;
	readonly providerConfiguration?: BedrockProviderConfiguration;
}

interface ToolUseBlockState {
	readonly id: string;
	readonly name: string;
	jsonInput: string;
}

interface ReasoningBlockState {
	text: string;
	signature: string;
	redactedContent?: Uint8Array;
}

interface BlockState {
	toolUse?: ToolUseBlockState;
	reasoning?: ReasoningBlockState;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class BedrockConverseProvider implements vscode.LanguageModelChatProvider<BedrockModelInformation> {

	private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

	constructor(private readonly _log: (message: string) => void) { }

	/** Re-run agent file discovery and notify the editor that the model list changed. */
	refresh(): void {
		this._onDidChangeLanguageModelChatInformation.fire();
	}

	async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<BedrockModelInformation[]> {
		const providerConfiguration = options.configuration as BedrockProviderConfiguration | undefined;
		const definitions = await discoverAgentFiles(message => this._log(message));
		return definitions.map(definition => this._toModelInformation(definition, providerConfiguration));
	}

	async provideLanguageModelChatResponse(
		model: BedrockModelInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const client = getBedrockClient(model.definition, model.providerConfiguration);

		const system = systemToConverseBlocks(model.definition.system);
		const toolConfig = toolsToConverseToolConfig(options.tools, options.toolMode);
		const inferenceOptions = buildInferenceOptions(model.definition, options.modelConfiguration);

		const input: ConverseStreamCommandInput = {
			modelId: model.definition.modelId,
			messages: apiMessagesToConverseMessages(messages),
			...(system ? { system } : {}),
			...inferenceOptions,
			...(toolConfig ? { toolConfig } : {}),
		};

		const abortController = new AbortController();
		const cancellationSubscription = token.onCancellationRequested(() => abortController.abort());
		try {
			const response = await client.send(new ConverseStreamCommand(input), { abortSignal: abortController.signal });
			const blocks = new Map<number, BlockState>();

			for await (const event of response.stream ?? []) {
				if (token.isCancellationRequested) {
					break;
				}

				if (event.contentBlockStart) {
					const index = event.contentBlockStart.contentBlockIndex ?? 0;
					const toolUse = event.contentBlockStart.start?.toolUse;
					if (toolUse) {
						blocks.set(index, { toolUse: { id: toolUse.toolUseId ?? '', name: toolUse.name ?? '', jsonInput: '' } });
					}
				} else if (event.contentBlockDelta) {
					const index = event.contentBlockDelta.contentBlockIndex ?? 0;
					const delta = event.contentBlockDelta.delta;
					if (!delta) {
						continue;
					}
					if (typeof delta.text === 'string' && delta.text.length > 0) {
						progress.report(new vscode.LanguageModelTextPart(delta.text));
					}
					if (delta.toolUse?.input) {
						const state = blocks.get(index);
						if (state?.toolUse) {
							state.toolUse.jsonInput += delta.toolUse.input;
						}
					}
					if (delta.reasoningContent) {
						let state = blocks.get(index);
						if (!state) {
							state = {};
							blocks.set(index, state);
						}
						state.reasoning ??= { text: '', signature: '' };
						const reasoning = delta.reasoningContent;
						if (typeof reasoning.text === 'string' && reasoning.text.length > 0) {
							state.reasoning.text += reasoning.text;
							progress.report(new vscode.LanguageModelThinkingPart(reasoning.text));
						}
						if (typeof reasoning.signature === 'string') {
							state.reasoning.signature += reasoning.signature;
						}
						if (reasoning.redactedContent) {
							state.reasoning.redactedContent = reasoning.redactedContent;
						}
					}
				} else if (event.contentBlockStop) {
					const index = event.contentBlockStop.contentBlockIndex ?? 0;
					const state = blocks.get(index);
					blocks.delete(index);
					if (state?.toolUse) {
						this._finishToolCall(state.toolUse, progress);
					}
					if (state?.reasoning) {
						this._finishReasoning(state.reasoning, progress);
					}
				} else if (event.metadata?.usage) {
					const usage = event.metadata.usage;
					const apiUsage = {
						prompt_tokens: usage.inputTokens ?? 0,
						completion_tokens: usage.outputTokens ?? 0,
						total_tokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
					};
					progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(apiUsage)), USAGE_MIME_TYPE));
				} else if (event.internalServerException) {
					throw new Error(`Bedrock internal server error: ${event.internalServerException.message ?? 'unknown'}`);
				} else if (event.modelStreamErrorException) {
					throw new Error(`Bedrock model stream error: ${event.modelStreamErrorException.message ?? 'unknown'}`);
				} else if (event.throttlingException) {
					throw new Error(`Bedrock throttling error: ${event.throttlingException.message ?? 'unknown'}`);
				} else if (event.validationException) {
					throw new Error(`Bedrock validation error: ${event.validationException.message ?? 'unknown'}`);
				} else if (event.serviceUnavailableException) {
					throw new Error(`Bedrock service unavailable: ${event.serviceUnavailableException.message ?? 'unknown'}`);
				}
			}

			// Flush any blocks left open by a truncated stream.
			for (const state of blocks.values()) {
				if (state.toolUse) {
					this._finishToolCall(state.toolUse, progress);
				}
				if (state.reasoning) {
					this._finishReasoning(state.reasoning, progress);
				}
			}
		} catch (error) {
			if (token.isCancellationRequested) {
				return;
			}
			this._log(`Converse request failed for model "${model.definition.id}" (${model.definition.modelId}): ${errorMessage(error)}`);
			throw error;
		} finally {
			cancellationSubscription.dispose();
		}
	}

	async provideTokenCount(_model: BedrockModelInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const str = typeof text === 'string'
			? text
			: text.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
		return Math.max(1, Math.ceil(str.length / 4));
	}

	private _finishToolCall(toolUse: ToolUseBlockState, progress: vscode.Progress<vscode.LanguageModelResponsePart2>): void {
		let input: object = {};
		if (toolUse.jsonInput.length > 0) {
			try {
				input = JSON.parse(toolUse.jsonInput);
			} catch {
				this._log(`Failed to parse tool call input for "${toolUse.name}" as JSON: ${toolUse.jsonInput}`);
			}
		}
		progress.report(new vscode.LanguageModelToolCallPart(toolUse.id, toolUse.name, input));
	}

	private _finishReasoning(reasoning: ReasoningBlockState, progress: vscode.Progress<vscode.LanguageModelResponsePart2>): void {
		// The final thinking part carries the complete block in metadata so the
		// next request can replay it into the assistant's history.
		if (reasoning.redactedContent) {
			const finalPart = new vscode.LanguageModelThinkingPart('');
			finalPart.metadata = { [ThinkingMetadataKeys.RedactedContent]: Buffer.from(reasoning.redactedContent).toString('base64') };
			progress.report(finalPart);
		} else if (reasoning.text.length > 0) {
			const finalPart = new vscode.LanguageModelThinkingPart('');
			finalPart.metadata = {
				[ThinkingMetadataKeys.CompleteThinking]: reasoning.text,
				[ThinkingMetadataKeys.Signature]: reasoning.signature,
			};
			progress.report(finalPart);
		}
	}

	private _toModelInformation(definition: BedrockAgentDefinition, providerConfiguration: BedrockProviderConfiguration | undefined): BedrockModelInformation {
		const capabilities = definition.capabilities;
		return {
			id: definition.id,
			name: definition.name,
			family: 'bedrock',
			version: '1.0.0',
			maxInputTokens: capabilities?.maxInputTokens ?? 128_000,
			maxOutputTokens: capabilities?.maxOutputTokens ?? 8_192,
			...(capabilities?.maxContextWindowTokens !== undefined ? { maxContextWindowTokens: capabilities.maxContextWindowTokens } : {}),
			isBYOK: true,
			isUserSelectable: true,
			tooltip: definition.description ?? definition.modelId,
			detail: `AWS Bedrock · ${resolveRegion(definition, providerConfiguration)}`,
			...(definition.configurationSchema ? { configurationSchema: definition.configurationSchema as vscode.LanguageModelConfigurationSchema } : {}),
			capabilities: {
				toolCalling: capabilities?.toolCalling ?? false,
				imageInput: capabilities?.imageInput ?? false,
				...(capabilities?.editTools ? { editTools: [...capabilities.editTools] } : {}),
			},
			definition,
			providerConfiguration,
		};
	}
}
