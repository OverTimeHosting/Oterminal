/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: number | string | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcSuccess {
	jsonrpc: '2.0';
	id: number | string | null;
	result: unknown;
}

export interface JsonRpcError {
	jsonrpc: '2.0';
	id: number | string | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export const RpcErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
} as const;

export class RpcError extends Error {
	constructor(public readonly code: number, message: string, public readonly data?: unknown) {
		super(message);
	}
}

export function makeSuccess(id: number | string | null, result: unknown): JsonRpcSuccess {
	return { jsonrpc: '2.0', id, result };
}

export function makeError(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcError {
	return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
