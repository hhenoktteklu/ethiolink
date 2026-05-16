// EthioLink — JSON projection for an `Appointment` domain object.
//
// Customer and business endpoints return the same shape — both
// parties see the full booking, including the counter-party's
// identifier. Handlers serialize the domain object through this
// view so timestamps land as ISO-8601 strings and the soft-delete
// flag never leaks to clients.
//
// If a public anonymous-caller view of an appointment is ever
// needed (it is not in MVP), a second projection that hides
// `customerId` / `notes` will be added alongside this one.

import type {
    PaymentAuthorization,
    PaymentAuthorizationStatus,
    PaymentProvider,
} from '../../adapters/payments/PaymentGateway.js';

import type { Appointment } from './appointmentsRepository.js';

export interface AppointmentView {
    readonly id: string;
    readonly customerId: string;
    readonly businessId: string;
    readonly serviceId: string;
    readonly staffId: string;
    /** UTC ISO-8601. */
    readonly startsAt: string;
    /** UTC ISO-8601. */
    readonly endsAt: string;
    readonly status: Appointment['status'];
    readonly paymentMethod: Appointment['paymentMethod'];
    readonly priceEtb: number;
    readonly notes: string | null;
    readonly cancelledBy: Appointment['cancelledBy'];
    readonly cancelReason: string | null;
    /** UTC ISO-8601. */
    readonly createdAt: string;
    /** UTC ISO-8601. */
    readonly updatedAt: string;
}

export function toAppointmentView(appointment: Appointment): AppointmentView {
    return Object.freeze<AppointmentView>({
        id: appointment.id,
        customerId: appointment.customerId,
        businessId: appointment.businessId,
        serviceId: appointment.serviceId,
        staffId: appointment.staffId,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        status: appointment.status,
        paymentMethod: appointment.paymentMethod,
        priceEtb: appointment.priceEtb,
        notes: appointment.notes,
        cancelledBy: appointment.cancelledBy,
        cancelReason: appointment.cancelReason,
        createdAt: appointment.createdAt.toISOString(),
        updatedAt: appointment.updatedAt.toISOString(),
    });
}

// ---------------------------------------------------------------------------
// Phase 10 — create-appointment response wrapper
// ---------------------------------------------------------------------------
//
// `POST /v1/appointments` returns the appointment plus an inline
// `payment` block carrying the gateway-issued authorization state.
// Cash bookings always land as `SUCCEEDED` + `redirectUrl: null`;
// online bookings against Chapa land as `PENDING` + the hosted
// checkout URL until the webhook flips them to SUCCEEDED.
//
// List / read endpoints continue to return the plain `AppointmentView`
// shape — payment context is only meaningful at the moment of
// authorization. A future "appointment payment history" surface
// would query the `payment_intents` table directly rather than
// extending this view.

/**
 * Public payment-summary block emitted alongside the appointment
 * view on the create response. Mirrors the consumable subset of
 * `PaymentAuthorization` — internal-only fields like `rawResponse`
 * and `authorizedAt` are intentionally elided so we don't leak
 * provider-specific debug data on the wire.
 */
export interface PaymentSummary {
    readonly status: PaymentAuthorizationStatus;
    readonly provider: PaymentProvider;
    readonly providerRef: string | null;
    /**
     * Provider-hosted checkout URL the mobile client should open
     * when the gateway returns `PENDING`. Null for synchronous
     * gateways (`CASH`) and for terminal outcomes that don't carry
     * a redirect step.
     */
    readonly redirectUrl: string | null;
    /** Short stable code on `FAILED` outcomes; null otherwise. */
    readonly errorCode: string | null;
    /** Human-readable failure reason; null otherwise. */
    readonly errorMessage: string | null;
}

/**
 * Wire shape returned by `POST /v1/appointments`. The appointment
 * sits in the `appointment` field rather than at the top level so
 * the response is unambiguously distinguishable from the
 * `AppointmentView` shape returned by list endpoints — and so a
 * future client can ignore the `payment` block by reading only
 * `appointment`.
 */
export interface CreateAppointmentResponse {
    readonly appointment: AppointmentView;
    readonly payment: PaymentSummary;
}

export function toCreateAppointmentResponse(
    appointment: Appointment,
    payment: PaymentAuthorization,
): CreateAppointmentResponse {
    return Object.freeze<CreateAppointmentResponse>({
        appointment: toAppointmentView(appointment),
        payment: Object.freeze<PaymentSummary>({
            status: payment.status,
            provider: payment.provider,
            providerRef: payment.providerRef ?? null,
            redirectUrl: payment.redirectUrl ?? null,
            errorCode: payment.errorCode ?? null,
            errorMessage: payment.errorMessage ?? null,
        }),
    });
}
