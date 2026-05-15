// EthioLink admin — typed API client.
//
// Thin wrapper around `fetch` that:
//   * Prefixes every path with `VITE_API_BASE_URL`.
//   * Attaches `Authorization: Bearer <id_token>` when an admin
//     session is available (the backend authorizer validates the
//     Cognito JWT; the id_token carries the `cognito:groups` claim
//     the API authorizer reads).
//   * Parses the server's standard error envelope (`{ error: { code,
//     message, details } }`) into a typed `ApiError`.
//
// The function surface is deliberately small — one helper per
// admin endpoint the dashboard actually calls. New endpoints land
// here as page components grow their data needs; resisting the urge
// to scaffold every endpoint up front keeps unused exports out of
// the bundle.
//
// Env var: `VITE_API_BASE_URL` — e.g. `http://localhost:3000` when
// running `sam local`, or the API Gateway invoke URL in dev.

import { getStoredSession } from './auth';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string).replace(
    /\/$/,
    '',
);

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ApiError extends Error {
    public readonly status: number;
    public readonly code: string | null;
    public readonly details: Record<string, unknown> | null;
    constructor(
        status: number,
        code: string | null,
        message: string,
        details: Record<string, unknown> | null,
    ) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

async function request<T>(
    method: string,
    path: string,
    body?: unknown,
): Promise<T> {
    const session = getStoredSession();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    if (session) {
        headers['Authorization'] = `Bearer ${session.idToken}`;
    }

    const response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 204) {
        return undefined as T;
    }

    const text = await response.text();
    const json: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
        const errObj = (json as {
            error?: {
                code?: string;
                message?: string;
                details?: Record<string, unknown>;
            };
        } | null)?.error ?? null;
        throw new ApiError(
            response.status,
            errObj?.code ?? null,
            errObj?.message ?? response.statusText,
            errObj?.details ?? null,
        );
    }
    return json as T;
}

// ---------------------------------------------------------------------------
// Typed surface — start small; extend per page as needed
// ---------------------------------------------------------------------------

export type BusinessStatus =
    | 'DRAFT'
    | 'PENDING_REVIEW'
    | 'APPROVED'
    | 'REJECTED'
    | 'SUSPENDED';

export interface BusinessOwnerView {
    readonly id: string;
    readonly ownerUserId: string;
    readonly categoryId: string;
    readonly name: string | null;
    readonly city: string | null;
    readonly status: BusinessStatus;
    readonly featuredUntil: string | null;
    readonly ratingAvg: number;
    readonly ratingCount: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface BusinessOwnerListResponse {
    readonly items: readonly BusinessOwnerView[];
}

export function listAdminBusinesses(
    params: { status?: BusinessStatus; limit?: number } = {},
): Promise<BusinessOwnerListResponse> {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set('status', params.status);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return request<BusinessOwnerListResponse>(
        'GET',
        `/v1/admin/businesses${query ? `?${query}` : ''}`,
    );
}
