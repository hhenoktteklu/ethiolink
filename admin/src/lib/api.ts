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

// ---------------------------------------------------------------------------
// Admin write actions
// ---------------------------------------------------------------------------
//
// All four endpoints accept an optional `notes` body that the
// backend stores on the matching `admin_actions` row. Each returns
// the updated `BusinessOwnerView`. Failed writes throw `ApiError`.

export function approveBusiness(
    id: string,
    notes?: string | null,
): Promise<BusinessOwnerView> {
    return request<BusinessOwnerView>(
        'POST',
        `/v1/admin/businesses/${encodeURIComponent(id)}/approve`,
        { notes: notes ?? null },
    );
}

export function rejectBusiness(
    id: string,
    notes?: string | null,
): Promise<BusinessOwnerView> {
    return request<BusinessOwnerView>(
        'POST',
        `/v1/admin/businesses/${encodeURIComponent(id)}/reject`,
        { notes: notes ?? null },
    );
}

export function suspendBusiness(
    id: string,
    notes?: string | null,
): Promise<BusinessOwnerView> {
    return request<BusinessOwnerView>(
        'POST',
        `/v1/admin/businesses/${encodeURIComponent(id)}/suspend`,
        { notes: notes ?? null },
    );
}

/**
 * Feature a business until the given `featuredUntil` instant. The
 * backend emits a `FEATURE_BUSINESS` audit row. Only valid for
 * APPROVED businesses; any other status returns 409 CONFLICT.
 */
export function featureBusiness(
    id: string,
    featuredUntil: Date,
    notes?: string | null,
): Promise<BusinessOwnerView> {
    return request<BusinessOwnerView>(
        'POST',
        `/v1/admin/businesses/${encodeURIComponent(id)}/feature`,
        { featuredUntil: featuredUntil.toISOString(), notes: notes ?? null },
    );
}

/**
 * Clear `featured_until`. The backend emits a distinct
 * `UNFEATURE_BUSINESS` audit row (separate from `FEATURE_BUSINESS`)
 * so the audit history distinguishes the two intents. Only valid
 * for APPROVED businesses.
 */
export function unfeatureBusiness(
    id: string,
    notes?: string | null,
): Promise<BusinessOwnerView> {
    return request<BusinessOwnerView>(
        'POST',
        `/v1/admin/businesses/${encodeURIComponent(id)}/feature`,
        { featuredUntil: null, notes: notes ?? null },
    );
}

// ---------------------------------------------------------------------------
// Admin featuring (Phase 9 Track 6 paid featuring)
// ---------------------------------------------------------------------------
//
// Three admin-side endpoints sit alongside the existing manual
// `feature` / `unfeature` audit-only path:
//
//   * `GET    /v1/admin/businesses/{id}/featuring/history` — every
//     featuring subscription for the business newest-first.
//   * `POST   /v1/admin/businesses/{id}/featuring/comp`     — create
//     an ADMIN_COMP subscription (zero price, ACTIVE on landing).
//     Refuses with 409 when another ACTIVE subscription already
//     exists.
//   * `POST   /v1/admin/businesses/{id}/featuring/cancel`   — flip
//     the currently-ACTIVE subscription to CANCELLED and recompute
//     `business_profiles.featured_until`. Refunds are out-of-band.
//
// The existing manual `featureBusiness` / `unfeatureBusiness`
// admin-action path stays — it writes a `featured_until` stamp
// without creating a subscription row. The two paths coexist:
// manual feature is the legacy operator escape hatch (no
// audit-history visibility), while the comp path is the canonical
// "give a business N days for free" workflow.

export type FeaturingPackageCode = 'FEATURING_7D' | 'FEATURING_30D';

export type FeaturingSubscriptionStatus =
    | 'PENDING_PAYMENT'
    | 'ACTIVE'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'REFUNDED';

export type FeaturingSubscriptionSource = 'OWNER_PURCHASE' | 'ADMIN_COMP';

/**
 * Mirrors the OpenAPI `FeaturingSubscription` schema. The
 * `paymentIntentId` field is NOT carried on the wire today — the
 * backend stores the FK internally so future refund tooling can
 * resolve the gateway transaction, but the public view stays
 * minimal. The admin panel surfaces "—" for now and the column
 * lights up once the read schema widens.
 */
export interface FeaturingSubscriptionView {
    readonly id: string;
    readonly businessId: string;
    readonly packageCode: FeaturingPackageCode;
    readonly priceEtb: number;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: FeaturingSubscriptionStatus;
    readonly source: FeaturingSubscriptionSource;
    readonly cancelledAt: string | null;
    readonly cancelledReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface FeaturingSubscriptionListResponse {
    readonly items: readonly FeaturingSubscriptionView[];
}

export function getAdminFeaturingHistory(
    businessId: string,
    params: { limit?: number } = {},
): Promise<FeaturingSubscriptionListResponse> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return request<FeaturingSubscriptionListResponse>(
        'GET',
        `/v1/admin/businesses/${encodeURIComponent(businessId)}/featuring/history${query ? `?${query}` : ''}`,
    );
}

export interface AdminCompFeaturingInput {
    readonly durationDays: number;
    readonly reason: string;
}

/**
 * Create an ADMIN_COMP featuring subscription. The server writes
 * the row with `source = ADMIN_COMP`, `price_etb = 0`, and
 * `status = ACTIVE`; `endsAt` is computed as
 * `now() + durationDays * 24h`. Refuses with 409 CONFLICT when
 * another ACTIVE subscription already exists.
 */
export function compAdminFeaturing(
    businessId: string,
    input: AdminCompFeaturingInput,
): Promise<FeaturingSubscriptionView> {
    return request<FeaturingSubscriptionView>(
        'POST',
        `/v1/admin/businesses/${encodeURIComponent(businessId)}/featuring/comp`,
        input,
    );
}

export interface AdminCancelFeaturingInput {
    readonly reason: string;
}

/**
 * Force-cancel the currently-ACTIVE featuring subscription. The
 * server flips `status` to `CANCELLED`, records `cancelledReason`,
 * and recomputes `business_profiles.featured_until`. Refunds (if
 * any) are out-of-band. Refuses with 409 CONFLICT when no ACTIVE
 * subscription exists.
 */
export function cancelAdminFeaturing(
    businessId: string,
    input: AdminCancelFeaturingInput,
): Promise<FeaturingSubscriptionView> {
    return request<FeaturingSubscriptionView>(
        'POST',
        `/v1/admin/businesses/${encodeURIComponent(businessId)}/featuring/cancel`,
        input,
    );
}

// ---------------------------------------------------------------------------
// Admin categories
// ---------------------------------------------------------------------------

/**
 * JSONB-localized text. MVP writes only `en`; `am` (Amharic) is
 * reserved for a later content pass. Same shape as the backend
 * `LocalizedText`.
 */
export interface LocalizedText {
    readonly en: string;
    readonly am?: string;
}

export interface AdminCategoryView {
    readonly id: string;
    readonly slug: string;
    readonly name: LocalizedText;
    readonly sortOrder: number;
    readonly isActive: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface AdminCategoryListResponse {
    readonly items: readonly AdminCategoryView[];
}

export function listAdminCategories(
    params: { isActive?: boolean; limit?: number } = {},
): Promise<AdminCategoryListResponse> {
    const search = new URLSearchParams();
    if (params.isActive !== undefined) {
        search.set('isActive', params.isActive ? 'true' : 'false');
    }
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return request<AdminCategoryListResponse>(
        'GET',
        `/v1/admin/categories${query ? `?${query}` : ''}`,
    );
}

export interface CreateCategoryInput {
    readonly slug: string;
    readonly name: LocalizedText;
    readonly sortOrder?: number;
    readonly notes?: string | null;
}

export function createCategory(
    input: CreateCategoryInput,
): Promise<AdminCategoryView> {
    return request<AdminCategoryView>('POST', '/v1/admin/categories', input);
}

export interface PatchCategoryInput {
    readonly slug?: string;
    readonly name?: LocalizedText;
    readonly sortOrder?: number;
    readonly notes?: string | null;
}

export function patchCategory(
    id: string,
    patch: PatchCategoryInput,
): Promise<AdminCategoryView> {
    return request<AdminCategoryView>(
        'PATCH',
        `/v1/admin/categories/${encodeURIComponent(id)}`,
        patch,
    );
}

/**
 * Soft-delete (flips `is_active` to false). Already-inactive
 * categories return 409 CONFLICT. The backend doesn't expose a
 * reactivation path in MVP.
 */
export function deactivateCategory(
    id: string,
    notes?: string | null,
): Promise<AdminCategoryView> {
    return request<AdminCategoryView>(
        'DELETE',
        `/v1/admin/categories/${encodeURIComponent(id)}`,
        { notes: notes ?? null },
    );
}

// ---------------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------------

export type UserRole = 'CUSTOMER' | 'BUSINESS_OWNER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface AdminUserView {
    readonly id: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly displayName: string | null;
    readonly role: UserRole;
    readonly status: UserStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface AdminUserListResponse {
    readonly items: readonly AdminUserView[];
}

export function listAdminUsers(
    params: { status?: UserStatus; role?: UserRole; limit?: number } = {},
): Promise<AdminUserListResponse> {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set('status', params.status);
    if (params.role !== undefined) search.set('role', params.role);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return request<AdminUserListResponse>(
        'GET',
        `/v1/admin/users${query ? `?${query}` : ''}`,
    );
}

/**
 * Move an ACTIVE user to SUSPENDED. The backend emits a
 * `SUSPEND_USER` audit row carrying the optional `notes`. SUSPENDED
 * and DELETED users return 409 CONFLICT (DELETED is terminal in
 * MVP).
 *
 * Suspension marks the row only — Cognito tokens stay valid until
 * expiration; the API authorizer rejects suspended users on the
 * next request. Token-side revocation is a Phase 7/8 hardening
 * item, not an MVP concern.
 */
export function suspendUser(
    id: string,
    notes?: string | null,
): Promise<AdminUserView> {
    return request<AdminUserView>(
        'POST',
        `/v1/admin/users/${encodeURIComponent(id)}/suspend`,
        { notes: notes ?? null },
    );
}

/**
 * Move a SUSPENDED user to ACTIVE. The backend emits a
 * `RESTORE_USER` audit row. ACTIVE and DELETED users return 409
 * CONFLICT; DELETED is terminal and can't be restored through this
 * path in MVP.
 */
export function restoreUser(
    id: string,
    notes?: string | null,
): Promise<AdminUserView> {
    return request<AdminUserView>(
        'POST',
        `/v1/admin/users/${encodeURIComponent(id)}/restore`,
        { notes: notes ?? null },
    );
}

// ---------------------------------------------------------------------------
// Admin appointments (read-only cross-business listing)
// ---------------------------------------------------------------------------

export type AppointmentStatus =
    | 'REQUESTED'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'NO_SHOW';

export type PaymentMethod = 'CASH' | 'ONLINE_PENDING';

export type CancelledBy = 'CUSTOMER' | 'BUSINESS' | 'ADMIN';

/**
 * Wire shape returned by every appointment endpoint — the
 * `AppointmentView` from the backend's appointmentView module.
 * Hides `deletedAt` (soft-delete filter is server-side).
 */
export interface AppointmentView {
    readonly id: string;
    readonly customerId: string;
    readonly businessId: string;
    readonly serviceId: string;
    readonly staffId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: AppointmentStatus;
    readonly paymentMethod: PaymentMethod;
    readonly priceEtb: number;
    readonly notes: string | null;
    readonly cancelledBy: CancelledBy | null;
    readonly cancelReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface AppointmentListResponse {
    readonly items: readonly AppointmentView[];
}

/**
 * Cross-business appointment listing. All filters optional;
 * passing none returns every active appointment up to `limit`.
 * `fromUtc` / `toUtc` accept either a `Date` or an ISO-8601
 * string — Dates are converted via `.toISOString()` before
 * landing in the URL query.
 *
 * No cursor pagination in MVP; the backend caps at 100.
 */
export function listAdminAppointments(
    params: {
        status?: AppointmentStatus;
        businessId?: string;
        customerId?: string;
        fromUtc?: Date | string;
        toUtc?: Date | string;
        limit?: number;
    } = {},
): Promise<AppointmentListResponse> {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set('status', params.status);
    if (params.businessId !== undefined)
        search.set('businessId', params.businessId);
    if (params.customerId !== undefined)
        search.set('customerId', params.customerId);
    if (params.fromUtc !== undefined) {
        search.set('from', toIsoString(params.fromUtc));
    }
    if (params.toUtc !== undefined) {
        search.set('to', toIsoString(params.toUtc));
    }
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return request<AppointmentListResponse>(
        'GET',
        `/v1/admin/appointments${query ? `?${query}` : ''}`,
    );
}

function toIsoString(value: Date | string): string {
    if (typeof value === 'string') return value;
    return value.toISOString();
}

// ---------------------------------------------------------------------------
// Admin notifications
// ---------------------------------------------------------------------------

export type NotificationStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

export type NotificationChannel =
    | 'SMS'
    | 'EMAIL'
    | 'TELEGRAM'
    | 'PUSH'
    | 'MOCK';

export interface NotificationLogView {
    readonly id: string;
    readonly recipientUserId: string | null;
    readonly channel: NotificationChannel;
    readonly templateKey: string;
    readonly payload: Record<string, unknown>;
    readonly status: NotificationStatus;
    readonly provider: string;
    readonly providerRef: string | null;
    readonly errorMessage: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface NotificationLogListResponse {
    readonly items: readonly NotificationLogView[];
}

/**
 * Notification-logs listing for the admin troubleshooting page.
 * All filters optional; passing none returns the most recent
 * attempts up to `limit` (default 100, max 100). `fromUtc` /
 * `toUtc` accept either a `Date` or an ISO-8601 string — Dates
 * are converted via `.toISOString()` before landing in the URL
 * query.
 *
 * Sort: `created_at DESC, id DESC` — newest attempts first.
 */
export function listAdminNotifications(
    params: {
        status?: NotificationStatus;
        channel?: NotificationChannel;
        recipientUserId?: string;
        fromUtc?: Date | string;
        toUtc?: Date | string;
        limit?: number;
    } = {},
): Promise<NotificationLogListResponse> {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set('status', params.status);
    if (params.channel !== undefined) search.set('channel', params.channel);
    if (params.recipientUserId !== undefined) {
        search.set('recipientUserId', params.recipientUserId);
    }
    if (params.fromUtc !== undefined) {
        search.set('from', toIsoString(params.fromUtc));
    }
    if (params.toUtc !== undefined) {
        search.set('to', toIsoString(params.toUtc));
    }
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return request<NotificationLogListResponse>(
        'GET',
        `/v1/admin/notifications${query ? `?${query}` : ''}`,
    );
}
