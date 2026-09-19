/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as jsonc from 'jsonc-parser';

/**
 * A bring-your-own-agent definition, parsed from a JSON file.
 * The field names intentionally mirror the AWS Bedrock Converse API
 * (modelId, inferenceConfig, system, additionalModelRequestFields).
 */
export interface BedrockAgentDefinition {
	/** Unique id of the model within the `bedrock` vendor. */
	readonly id: string;
	/** Human-readable name shown in the model picker. */
	readonly name: string;
	/** Optional longer description, used as tooltip. */
	readonly description?: string;
	/** Bedrock model ID or inference-profile ID/ARN. */
	readonly modelId: string;
	/** AWS region. Resolution order: this value, provider configuration, AWS_REGION, us-west-2. */
	readonly region?: string;
	/** Optional named AWS profile. When unset, the default credential provider chain is used. */
	readonly profile?: string;
	/** System prompts, sent as Converse `system` content blocks. */
	readonly system?: readonly string[];
	/** Converse inference configuration. */
	readonly inferenceConfig?: BedrockInferenceConfig;
	/** Model-specific request fields, passed through verbatim. */
	readonly additionalModelRequestFields?: Record<string, unknown>;
	/** JSON schema describing per-model user configuration options. Passed through to the editor. */
	readonly configurationSchema?: { readonly properties?: Record<string, unknown> };
	readonly capabilities?: BedrockAgentCapabilities;
	/** Path of the file this definition was parsed from (for diagnostics). */
	readonly sourcePath: string;
}

export interface BedrockInferenceConfig {
	readonly maxTokens?: number;
	readonly stopSequences?: readonly string[];
	readonly temperature?: number;
	readonly topP?: number;
	/**
	 * Converse has no `topK` in `InferenceConfiguration`; it is routed to
	 * `additionalModelRequestFields` where supporting models expect it.
	 */
	readonly topK?: number;
}

export interface BedrockAgentCapabilities {
	readonly toolCalling?: boolean;
	readonly imageInput?: boolean;
	readonly thinking?: boolean;
	readonly editTools?: readonly string[];
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly maxContextWindowTokens?: number;
}

export type ParseAgentFileResult =
	| { readonly definition: BedrockAgentDefinition; readonly errors?: undefined }
	| { readonly definition?: undefined; readonly errors: readonly string[] };

const VALID_EDIT_TOOLS = new Set(['find-replace', 'multi-find-replace', 'apply-patch', 'code-rewrite']);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(obj: Record<string, unknown>, key: string, errors: string[]): string | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || value.length === 0) {
		errors.push(`"${key}" must be a non-empty string`);
		return undefined;
	}
	return value;
}

function readOptionalNumber(obj: Record<string, unknown>, key: string, errors: string[]): number | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		errors.push(`"${key}" must be a finite number`);
		return undefined;
	}
	return value;
}

function readOptionalBoolean(obj: Record<string, unknown>, key: string, errors: string[]): boolean | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		errors.push(`"${key}" must be a boolean`);
		return undefined;
	}
	return value;
}

function readOptionalStringArray(obj: Record<string, unknown>, key: string, errors: string[]): string[] | undefined {
	const value = obj[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === 'string' && value.length > 0) {
		return [value];
	}
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
		errors.push(`"${key}" must be a string or an array of non-empty strings`);
		return undefined;
	}
	return value.length > 0 ? [...value] : undefined;
}

function parseInferenceConfig(raw: unknown, errors: string[]): BedrockInferenceConfig | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!isObject(raw)) {
		errors.push('"inferenceConfig" must be an object');
		return undefined;
	}
	const config: { -readonly [K in keyof BedrockInferenceConfig]?: BedrockInferenceConfig[K] } = {};
	const maxTokens = readOptionalNumber(raw, 'maxTokens', errors);
	if (maxTokens !== undefined) {
		if (!Number.isInteger(maxTokens) || maxTokens < 1) {
			errors.push('"inferenceConfig.maxTokens" must be a positive integer');
		} else {
			config.maxTokens = maxTokens;
		}
	}
	const temperature = readOptionalNumber(raw, 'temperature', errors);
	if (temperature !== undefined) {
		config.temperature = temperature;
	}
	const topP = readOptionalNumber(raw, 'topP', errors);
	if (topP !== undefined) {
		config.topP = topP;
	}
	const topK = readOptionalNumber(raw, 'topK', errors);
	if (topK !== undefined) {
		if (!Number.isInteger(topK) || topK < 0) {
			errors.push('"inferenceConfig.topK" must be a non-negative integer');
		} else {
			config.topK = topK;
		}
	}
	const stopSequences = readOptionalStringArray(raw, 'stopSequences', errors);
	if (stopSequences !== undefined) {
		config.stopSequences = stopSequences;
	}
	return config;
}

function parseCapabilities(raw: unknown, errors: string[]): BedrockAgentCapabilities | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (!isObject(raw)) {
		errors.push('"capabilities" must be an object');
		return undefined;
	}
	const capabilities: { -readonly [K in keyof BedrockAgentCapabilities]?: BedrockAgentCapabilities[K] } = {};
	const toolCalling = readOptionalBoolean(raw, 'toolCalling', errors);
	if (toolCalling !== undefined) {
		capabilities.toolCalling = toolCalling;
	}
	const imageInput = readOptionalBoolean(raw, 'imageInput', errors);
	if (imageInput !== undefined) {
		capabilities.imageInput = imageInput;
	}
	const thinking = readOptionalBoolean(raw, 'thinking', errors);
	if (thinking !== undefined) {
		capabilities.thinking = thinking;
	}
	for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxContextWindowTokens'] as const) {
		const value = readOptionalNumber(raw, key, errors);
		if (value !== undefined) {
			if (!Number.isInteger(value) || value < 1) {
				errors.push(`"capabilities.${key}" must be a positive integer`);
			} else {
				capabilities[key] = value;
			}
		}
	}
	const editTools = readOptionalStringArray(raw, 'editTools', errors);
	if (editTools !== undefined) {
		const invalid = editTools.filter(tool => !VALID_EDIT_TOOLS.has(tool));
		if (invalid.length > 0) {
			errors.push(`"capabilities.editTools" contains unrecognized entries: ${invalid.join(', ')} (recognized: ${[...VALID_EDIT_TOOLS].join(', ')})`);
		} else {
			capabilities.editTools = editTools;
		}
	}
	return capabilities;
}

/**
 * Parse and validate one agent definition file (JSONC is accepted).
 * Unknown top-level keys are tolerated so the format can evolve.
 */
export function parseAgentFile(content: string, sourcePath: string): ParseAgentFileResult {
	const parseErrors: jsonc.ParseError[] = [];
	const raw: unknown = jsonc.parse(content, parseErrors, { allowTrailingComma: true, disallowComments: false });
	const errors: string[] = parseErrors.map(error => `${jsonc.printParseErrorCode(error.error)} at offset ${error.offset}`);

	if (raw === undefined && parseErrors.length > 0) {
		return { errors };
	}
	if (!isObject(raw)) {
		errors.push('agent file must contain a JSON object at the top level');
		return { errors };
	}

	const id = readOptionalString(raw, 'id', errors);
	if (id !== undefined && !/^[\w][\w\-.]*$/.test(id)) {
		errors.push('"id" must start with a letter, digit or underscore and contain only letters, digits, underscores, hyphens and dots');
	}
	const name = readOptionalString(raw, 'name', errors);
	const modelId = readOptionalString(raw, 'modelId', errors);
	const description = readOptionalString(raw, 'description', errors);
	const region = readOptionalString(raw, 'region', errors);
	const profile = readOptionalString(raw, 'profile', errors);
	const system = readOptionalStringArray(raw, 'system', errors);
	const inferenceConfig = parseInferenceConfig(raw['inferenceConfig'], errors);
	const capabilities = parseCapabilities(raw['capabilities'], errors);

	let additionalModelRequestFields: Record<string, unknown> | undefined;
	const rawAdditionalFields = raw['additionalModelRequestFields'];
	if (rawAdditionalFields !== undefined) {
		if (!isObject(rawAdditionalFields)) {
			errors.push('"additionalModelRequestFields" must be an object');
		} else {
			additionalModelRequestFields = rawAdditionalFields;
		}
	}

	let configurationSchema: { readonly properties?: Record<string, unknown> } | undefined;
	const rawConfigurationSchema = raw['configurationSchema'];
	if (rawConfigurationSchema !== undefined) {
		if (!isObject(rawConfigurationSchema) || (rawConfigurationSchema['properties'] !== undefined && !isObject(rawConfigurationSchema['properties']))) {
			errors.push('"configurationSchema" must be an object with an optional "properties" object');
		} else {
			configurationSchema = rawConfigurationSchema as { readonly properties?: Record<string, unknown> };
		}
	}

	if (!id || !name || !modelId) {
		errors.push('"id", "name" and "modelId" are required');
	}
	if (errors.length > 0) {
		return { errors };
	}

	return {
		definition: {
			id: id!,
			name: name!,
			description,
			modelId: modelId!,
			region,
			profile,
			system,
			inferenceConfig,
			additionalModelRequestFields,
			configurationSchema,
			capabilities,
			sourcePath,
		}
	};
}
