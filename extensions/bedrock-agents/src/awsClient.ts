/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import type { BedrockAgentDefinition } from './agentFile';

/**
 * Provider-level configuration declared in package.json and delivered via
 * `PrepareLanguageModelChatModelOptions.configuration`. Secret fields are
 * stored in secret storage by the editor.
 */
export interface BedrockProviderConfiguration {
	readonly region?: string;
	readonly profile?: string;
	readonly accessKeyId?: string;
	readonly secretAccessKey?: string;
	readonly sessionToken?: string;
}

const DEFAULT_REGION = 'us-west-2';

/**
 * Resolve the AWS region for an agent.
 * Order: agent file, provider configuration, AWS_REGION env var, us-west-2.
 */
export function resolveRegion(definition: BedrockAgentDefinition, providerConfiguration: BedrockProviderConfiguration | undefined): string {
	return definition.region
		?? providerConfiguration?.region
		?? process.env['AWS_REGION']
		?? process.env['AWS_DEFAULT_REGION']
		?? DEFAULT_REGION;
}

const clientCache = new Map<string, BedrockRuntimeClient>();

/**
 * Get (or create) a cached Bedrock runtime client for an agent.
 * Credential precedence: explicit keys from the provider configuration,
 * then the agent/profile named profile, then the default provider chain
 * (environment variables, shared credentials/config files, SSO, IAM).
 */
export function getBedrockClient(definition: BedrockAgentDefinition, providerConfiguration: BedrockProviderConfiguration | undefined): BedrockRuntimeClient {
	const region = resolveRegion(definition, providerConfiguration);
	const profile = definition.profile ?? providerConfiguration?.profile;
	const hasExplicitCredentials = Boolean(providerConfiguration?.accessKeyId && providerConfiguration?.secretAccessKey);

	const cacheKey = JSON.stringify([region, hasExplicitCredentials ? providerConfiguration!.accessKeyId : profile]);
	let client = clientCache.get(cacheKey);
	if (!client) {
		client = new BedrockRuntimeClient({
			region,
			...(hasExplicitCredentials
				? {
					credentials: {
						accessKeyId: providerConfiguration!.accessKeyId!,
						secretAccessKey: providerConfiguration!.secretAccessKey!,
						...(providerConfiguration!.sessionToken ? { sessionToken: providerConfiguration!.sessionToken } : {}),
					}
				}
				: profile
					? { credentials: fromIni({ profile }) }
					: {}),
		});
		clientCache.set(cacheKey, client);
	}
	return client;
}
