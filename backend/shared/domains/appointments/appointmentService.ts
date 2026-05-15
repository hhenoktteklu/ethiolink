// EthioLink — appointment service.
//
// The booking-flow orchestrator. Composes:
//
//   * `AppointmentsRepository` — DB reads / writes.
//   * `BusinessRepository` — owner lookup for ownership checks.
//   * `ServiceRepository` — service lookup for price snapshot + duration.
//   * `SlotService` — slot validation. The same primitive the public
//     listing endpoint uses, so a booking-time validation cannot drift
//     from what the customer was shown.
//   * `appointmentStateMachine` — transition rules.
//   * `PaymentGateway` (two instances, routed by `payment_method`) —
//     `cashGateway` for CASH, `onlineGateway` for ONLINE_PENDING.
//   * `NotificationService` — fan-out of booking lifecycle events
//     to the recipient(s). Each successful mutation triggers ONE
//     `dispatch` call against the appropriate template key (see
//     `notifyBookingEvent`). Notifications are best-effort: any
//     error inside the dispatch path is logged and swallowed at
//     this layer so a failing notification cannot break a
//     booking. The dispatcher itself already catches provider
//     errors; the extra catch here is defense-in-depth against
//     anything else (e.g. a stale DB session, a thrown
//     `RepositoryError` on the log insert) and matches the
//     PHASE_6_NOTIFICATIONS.md acceptance criterion: "A failing
//     provider … does not break the booking flow." We notify on
//     create / accept / reject / cancel / reschedule. Complete
//     deliberately fires no notification in MVP — see the
//     COMPLETE comment below.
//
// Method-by-method summary:
//
//   create(input)          — Customer books a slot. Validates the slot
//                            via `SlotService`, snapshots `priceEtb`,
//                            authorizes payment, INSERTs the row.
//                            Translates SQLSTATE 23P01 (exclusion
//                            violation) to `AppointmentSlotUnavailableError`.
//   getById(id, caller)    — Returns the appointment if the caller is
//                            the customer, the business owner, or an
//                            admin. 404 / 403 otherwise.
//   listForCustomer        — Customer's own appointments.
//   listForBusiness        — Business owner's incoming appointments.
//   accept(id, caller)     — Business REQUESTED → ACCEPTED.
//   reject(id, caller)     — Business REQUESTED → REJECTED.
//   cancel(id, caller, …)  — Customer / business / admin. Customer is
//                            subject to the 4-hour cutoff; business
//                            and admin override.
//   reschedule(id, caller, …) — Customer moves the time window. Slot
//                            re-validated, status reset to REQUESTED.
//   complete(id, caller)   — Business ACCEPTED → COMPLETED.
//
// Errors are typed; the HTTP layer maps each to a stable response code
// (see PHASE_4_BOOKING.md for the matrix). Re-exports `InvalidAppointmentTransitionError`
// and `OnlinePaymentsUnavailableError` so handlers can catch all
// service-relevant errors from a single import.

import { randomUUID } from 'node:crypto';

import { DateTime } from 'luxon';

import type { UserRole } from '../../adapters/auth/AuthProvider.js';
import type {
    PaymentAuthorization,
    PaymentGateway,
} from '../../adapters/payments/PaymentGateway.js';
import {
    OnlinePaymentsUnavailableError,
    PaymentGatewayError,
} from '../../adapters/payments/PaymentGateway.js';
import type { Logger } from '../../logging/logger.js';
import type { Business, BusinessRepository } from '../businesses/businessRepository.js';
import {
    SlotInvalidRangeError,
    SlotInvalidTimezoneError,
    SlotServiceNotFoundError,
    type SlotService,
    SlotServiceStaffMismatchError,
    SlotStaffNotFoundError,
} from '../availability/slotService.js';
import type { NotificationChannel } from '../../adapters/notifications/NotificationGateway.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type {
    BookingTemplateKey,
    BookingTemplatePayload,
} from '../notifications/templateRegistry.js';
import type { Service, ServiceRepository } from '../services/serviceRepository.js';
import type { User, UserRepository } from '../users/userRepository.js';

import {
    type AppointmentActor,
    InvalidAppointmentTransitionError,
    assertAppointmentTransition,
} from './appointmentStateMachine.js';
import type {
    Appointment,
    AppointmentsRepository,
    CancelledBy,
    ListAppointmentsFilters,
    PaymentMethod,
} from './appointmentsRepository.js';

// Re-exports so HTTP handlers can import the union of error types
// they'll catch from this single module.
export {
    InvalidAppointmentTransitionError,
    OnlinePaymentsUnavailableError,
    PaymentGatewayError,
    SlotInvalidRangeError,
    SlotInvalidTimezoneError,
    SlotServiceNotFoundError,
    SlotServiceStaffMismatchError,
    SlotStaffNotFoundError,
};

// ---------------------------------------------------------------------------
// Caller context — identical shape across domain services
// ---------------------------------------------------------------------------

/** Identity of an authenticated caller. Built by the handler from the JWT. */
export interface CallerContext {
    readonly userId: string;
    readonly role: UserRole;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateAppointmentInput {
    readonly customerId: string;
    readonly staffId: string;
    readonly serviceId: string;
    /** UTC ISO-8601 timestamp the customer wants to book. */
    readonly startsAtUtc: string;
    readonly paymentMethod: PaymentMethod;
    readonly notes?: string | null;
    /** Test seam for the "is this slot still in the future" check. */
    readonly now?: Date;
}

export interface CreateAppointmentResult {
    readonly appointment: Appointment;
    readonly payment: PaymentAuthorization;
}

export interface CancelAppointmentInput {
    readonly reason?: string | null;
    /** Test seam for the cutoff check. */
    readonly now?: Date;
}

export interface RescheduleAppointmentInput {
    /** UTC ISO-8601 timestamp for the new slot start. */
    readonly newStartsAtUtc: string;
    /** Test seam. */
    readonly now?: Date;
}

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

export class AppointmentNotFoundError extends Error {
    public readonly appointmentId: string;
    constructor(appointmentId: string) {
        super(`Appointment ${appointmentId} not found.`);
        this.name = 'AppointmentNotFoundError';
        this.appointmentId = appointmentId;
    }
}

export class AppointmentNotOwnedError extends Error {
    constructor() {
        super('Caller is not authorized to act on this appointment.');
        this.name = 'AppointmentNotOwnedError';
    }
}

/**
 * Raised when an INSERT (create) or UPDATE (reschedule) loses the
 * exclusion-constraint race with a concurrent booking, OR when the
 * requested time does not appear in the slot list computed for the
 * day. Both surface to the customer as "this slot is no longer
 * available" — the distinction is invisible to clients.
 */
export class AppointmentSlotUnavailableError extends Error {
    constructor() {
        super('The requested slot is no longer available.');
        this.name = 'AppointmentSlotUnavailableError';
    }
}

/** Raised when a service has no price set and therefore cannot be booked. */
export class AppointmentMissingServicePriceError extends Error {
    public readonly serviceId: string;
    constructor(serviceId: string) {
        super(`Service ${serviceId} has no price set; cannot be booked.`);
        this.name = 'AppointmentMissingServicePriceError';
        this.serviceId = serviceId;
    }
}

/** Raised when a customer attempts to cancel inside the cutoff window. */
export class AppointmentCancellationCutoffError extends Error {
    public readonly cutoffMinutes: number;
    constructor(cutoffMinutes: number) {
        super(
            `Customers cannot cancel within ${cutoffMinutes} minutes of the appointment.`,
        );
        this.name = 'AppointmentCancellationCutoffError';
        this.cutoffMinutes = cutoffMinutes;
    }
}

/** Raised when the start timestamp cannot be parsed as a UTC ISO-8601 string. */
export class AppointmentInvalidStartTimeError extends Error {
    constructor(raw: string) {
        super(`Invalid ISO-8601 start timestamp: "${raw}".`);
        this.name = 'AppointmentInvalidStartTimeError';
    }
}

// ---------------------------------------------------------------------------
// Constants / dependencies
// ---------------------------------------------------------------------------

/** Postgres SQLSTATE for an exclusion-constraint violation. */
const PG_EXCLUSION_VIOLATION = '23P01';

export interface AppointmentServiceOptions {
    /**
     * Cancellation cutoff applied to CUSTOMER-initiated cancellations.
     * BUSINESS and ADMIN cancellations skip this check (per
     * PHASE_4_BOOKING.md). `0` disables the cutoff.
     */
    readonly cancelCutoffMinutes: number;
    /**
     * IANA timezone used to derive the local calendar date from a UTC
     * `startsAt` when computing slots for slot validation. Should
     * match `SlotService.options.timezone`; injected separately so
     * the appointment service does not need to crack SlotService open.
     */
    readonly timezone: string;
    /**
     * Phase 9 — enables SMS-channel routing for booking lifecycle
     * notifications. When `true`, each notification fetches the
     * recipient's `users` row and routes through the `SMS` channel
     * if and only if the recipient has a non-empty `phone`. When
     * `false` (the default, preserved for backward-compat and local
     * tests that don't wire an SMS gateway), every notification
     * routes through `MOCK` as before.
     *
     * The handler-side derivation is
     * `shouldWireSmsGateway(config)` from
     * `notificationServiceFactory.ts` — when the SMS gateway is
     * wired into the dispatcher, this flag is also true. Keeping
     * the two decisions in lockstep avoids the failure mode where
     * the service routes to a channel the dispatcher hasn't been
     * configured with (which would raise `NoGatewayForChannelError`
     * — caught by the dispatcher but persisted as a useless
     * `FAILED` row).
     *
     * Defaults to `false` when omitted so existing call sites
     * (tests, future handlers) don't accidentally opt in.
     */
    readonly smsRoutingEnabled?: boolean;
}

export interface AppointmentServiceDependencies {
    readonly appointmentsRepo: AppointmentsRepository;
    readonly businessRepo: BusinessRepository;
    readonly serviceRepo: ServiceRepository;
    readonly userRepo: UserRepository;
    readonly slotService: SlotService;
    readonly cashGateway: PaymentGateway;
    readonly onlineGateway: PaymentGateway;
    /**
     * Notification dispatcher invoked after each successful
     * lifecycle mutation (create / accept / reject / cancel /
     * reschedule). Best-effort: errors from `dispatch` are
     * logged + swallowed in `notifyBookingEvent`. Construct with
     * a `MockNotificationGateway` for MVP — real providers plug
     * in behind the same port.
     */
    readonly notificationService: NotificationService;
    /**
     * Structured logger used for the notification swallow path.
     * Anything that escapes `NotificationService.dispatch` (which
     * already catches provider failures) lands here as a warn so
     * the admin can see a notification miss without the booking
     * itself failing.
     */
    readonly logger: Logger;
    readonly options: AppointmentServiceOptions;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AppointmentService {
    private readonly deps: AppointmentServiceDependencies;

    constructor(deps: AppointmentServiceDependencies) {
        this.deps = deps;
    }

    // ----- Reads ------------------------------------------------------------

    /**
     * Fetch one appointment, enforcing visibility: the customer, the
     * business owner, or an admin can see it.
     */
    async getById(id: string, caller: CallerContext): Promise<Appointment> {
        const appointment = await this.findActiveOrThrow(id);
        await this.assertCanView(appointment, caller);
        return appointment;
    }

    /** List a customer's own appointments. The handler supplies `customerId = caller.userId`. */
    async listForCustomer(
        customerId: string,
        filters: ListAppointmentsFilters = {},
    ): Promise<readonly Appointment[]> {
        return this.deps.appointmentsRepo.listForCustomer(customerId, filters);
    }

    /**
     * List a business's incoming appointments. Caller must own the
     * business (or be ADMIN).
     */
    async listForBusiness(
        businessId: string,
        caller: CallerContext,
        filters: ListAppointmentsFilters = {},
    ): Promise<readonly Appointment[]> {
        await this.assertBusinessOwnerOrAdmin(businessId, caller);
        return this.deps.appointmentsRepo.listForBusiness(businessId, filters);
    }

    // ----- Create -----------------------------------------------------------

    /**
     * Create a new appointment. Steps:
     *   1. Resolve the local-tz date from `startsAtUtc`, ask
     *      `SlotService` for the day's slots, find the one that
     *      starts at exactly the requested instant.
     *   2. Read the service for its price (snapshot) and duration.
     *   3. Authorize payment through the routed gateway.
     *   4. INSERT. Translate 23P01 (exclusion violation) to
     *      `AppointmentSlotUnavailableError`.
     */
    async create(input: CreateAppointmentInput): Promise<CreateAppointmentResult> {
        const startsAt = parseIsoUtc(input.startsAtUtc);

        // (1) Slot validation via SlotService. Errors propagate
        // naturally: SlotStaffNotFoundError / SlotServiceNotFoundError /
        // SlotServiceStaffMismatchError surface to the handler.
        const localDate = DateTime.fromJSDate(startsAt, { zone: 'utc' })
            .setZone(this.deps.options.timezone)
            .toFormat('yyyy-LL-dd');
        const slots = await this.deps.slotService.computeSlots({
            staffId: input.staffId,
            serviceId: input.serviceId,
            fromDate: localDate,
            toDate: localDate,
            now: input.now,
        });
        const slot = slots.find((s) => s.startUtc === startsAt.toISOString());
        if (!slot) {
            // Either the time is misaligned with the slot grid, was
            // already booked between the listing call and now, or is
            // outside availability. All collapse to "unavailable" for
            // the customer.
            throw new AppointmentSlotUnavailableError();
        }
        const endsAt = new Date(slot.endUtc);

        // (2) Snapshot price + duration from the service. SlotService
        // already validated active/same-business; we re-fetch only to
        // read `priceEtb`. The cost of one extra SELECT vs. plumbing
        // the service through SlotService is acceptable for MVP.
        const service = await this.deps.serviceRepo.findById(input.serviceId);
        if (!service) {
            // Belt-and-braces: SlotService would have already thrown.
            throw new SlotServiceNotFoundError(input.serviceId);
        }
        if (service.priceEtb === null) {
            throw new AppointmentMissingServicePriceError(input.serviceId);
        }

        // (3) Payment authorization. The correlation id is a fresh
        // UUID; neither MVP gateway uses it, but a future real online
        // provider (Telebirr, Chapa, CBE Birr) will want a stable
        // app-side reference. This is a known wart — those providers
        // will need the *real* appointment id, which means generating
        // it pre-insert and passing it as `appointments.id` explicitly.
        // Postponed until a real provider lands.
        const correlationId = randomUUID();
        const payment = await this.routePayment(input.paymentMethod).authorize({
            appointmentId: correlationId,
            amountEtb: service.priceEtb,
            idempotencyKey: correlationId,
        });

        // (4) INSERT. The exclusion constraint is the authoritative
        // double-book guard; if a concurrent caller beat us between
        // step 1 and now, pg raises 23P01.
        let appointment: Appointment;
        try {
            appointment = await this.deps.appointmentsRepo.insert({
                customerId: input.customerId,
                businessId: service.businessId,
                serviceId: input.serviceId,
                staffId: input.staffId,
                startsAt,
                endsAt,
                paymentMethod: input.paymentMethod,
                priceEtb: service.priceEtb,
                notes: input.notes ?? null,
            });
        } catch (err) {
            if (isExclusionViolation(err)) {
                throw new AppointmentSlotUnavailableError();
            }
            throw err;
        }

        // (5) Notify the business owner that a customer just booked.
        // Best-effort — see `notifyBookingEvent` for the swallow contract.
        await this.notifyBusinessOwner(appointment, 'booking.requested.business');

        return Object.freeze<CreateAppointmentResult>({ appointment, payment });
    }

    // ----- Transitions ------------------------------------------------------

    /** Business REQUESTED → ACCEPTED. Notifies the customer. */
    async accept(id: string, caller: CallerContext): Promise<Appointment> {
        const appointment = await this.applyTransition(
            id,
            caller,
            'BUSINESS',
            'ACCEPT',
            null,
            null,
        );
        await this.notifyCustomer(appointment, 'booking.accepted.customer');
        return appointment;
    }

    /** Business REQUESTED → REJECTED. Notifies the customer. */
    async reject(id: string, caller: CallerContext): Promise<Appointment> {
        const appointment = await this.applyTransition(
            id,
            caller,
            'BUSINESS',
            'REJECT',
            null,
            null,
        );
        await this.notifyCustomer(appointment, 'booking.rejected.customer');
        return appointment;
    }

    /**
     * Customer / business / admin cancellation. Customer is subject
     * to `options.cancelCutoffMinutes`; business and admin override
     * the cutoff (state machine accepts CANCEL from all three actors).
     */
    async cancel(
        id: string,
        caller: CallerContext,
        input: CancelAppointmentInput = {},
    ): Promise<Appointment> {
        const appointment = await this.findActiveOrThrow(id);
        const actor = await this.deriveActor(appointment, caller);

        if (actor === 'CUSTOMER' && this.deps.options.cancelCutoffMinutes > 0) {
            const now = input.now ?? new Date();
            const millisToStart = appointment.startsAt.getTime() - now.getTime();
            const cutoffMs = this.deps.options.cancelCutoffMinutes * 60_000;
            if (millisToStart < cutoffMs) {
                throw new AppointmentCancellationCutoffError(
                    this.deps.options.cancelCutoffMinutes,
                );
            }
        }

        assertAppointmentTransition({
            action: 'CANCEL',
            actor,
            fromStatus: appointment.status,
        });

        const cancelled = await this.deps.appointmentsRepo.setStatus(id, {
            status: 'CANCELLED',
            cancelledBy: actor as CancelledBy,
            cancelReason: input.reason ?? null,
        });

        // Notify the *other* side of the booking.
        //   * CUSTOMER cancellation → tell the business owner.
        //   * BUSINESS or ADMIN cancellation → tell the customer.
        // ADMIN is treated like BUSINESS for the notification side
        // because the customer is the affected party either way; the
        // PHASE_6 rule "cancel by BUSINESS or ADMIN → cancelled.customer"
        // makes the directionality explicit.
        if (actor === 'CUSTOMER') {
            await this.notifyBusinessOwner(cancelled, 'booking.cancelled.business', {
                cancelReason: input.reason ?? null,
            });
        } else {
            await this.notifyCustomer(cancelled, 'booking.cancelled.customer', {
                cancelReason: input.reason ?? null,
            });
        }

        return cancelled;
    }

    /**
     * Customer reschedule. Slot is re-validated against the new
     * starts_at; status is reset to REQUESTED so the business must
     * re-accept the new window.
     *
     * Implementation is two writes: `repo.reschedule(...)` (time
     * change, catches 23P01) followed by `repo.setStatus(REQUESTED)`
     * if the row was ACCEPTED. Each write is independently safe under
     * the exclusion constraint; merging into a single statement is a
     * future optimization, not a correctness requirement.
     */
    async reschedule(
        id: string,
        caller: CallerContext,
        input: RescheduleAppointmentInput,
    ): Promise<Appointment> {
        const appointment = await this.findActiveOrThrow(id);
        const actor = await this.deriveActor(appointment, caller);

        // The state machine only permits RESCHEDULE by 'CUSTOMER' in
        // MVP, so ADMIN / BUSINESS attempts surface as
        // `InvalidAppointmentTransitionError`. Letting the matrix do
        // the enforcement keeps the per-action rules in one place.
        assertAppointmentTransition({
            action: 'RESCHEDULE',
            actor,
            fromStatus: appointment.status,
        });

        // Validate the new slot through the same SlotService path the
        // create flow uses.
        const newStartsAt = parseIsoUtc(input.newStartsAtUtc);
        const localDate = DateTime.fromJSDate(newStartsAt, { zone: 'utc' })
            .setZone(this.deps.options.timezone)
            .toFormat('yyyy-LL-dd');
        const slots = await this.deps.slotService.computeSlots({
            staffId: appointment.staffId,
            serviceId: appointment.serviceId,
            fromDate: localDate,
            toDate: localDate,
            now: input.now,
        });
        const slot = slots.find((s) => s.startUtc === newStartsAt.toISOString());
        if (!slot) {
            throw new AppointmentSlotUnavailableError();
        }
        const newEndsAt = new Date(slot.endUtc);

        let moved: Appointment;
        try {
            moved = await this.deps.appointmentsRepo.reschedule(id, {
                startsAt: newStartsAt,
                endsAt: newEndsAt,
            });
        } catch (err) {
            if (isExclusionViolation(err)) {
                throw new AppointmentSlotUnavailableError();
            }
            throw err;
        }

        let finalRow = moved;
        if (moved.status === 'ACCEPTED') {
            // Reset business confirmation. The state machine has
            // already approved RESCHEDULE; this second write is the
            // status side of that transition.
            finalRow = await this.deps.appointmentsRepo.setStatus(id, {
                status: 'REQUESTED',
                cancelledBy: null,
                cancelReason: null,
            });
        }

        // Only CUSTOMER can reschedule in MVP — the state machine
        // already enforced that above — so the recipient is always
        // the business owner.
        if (actor === 'CUSTOMER') {
            await this.notifyBusinessOwner(
                finalRow,
                'booking.rescheduled.business',
            );
        }

        return finalRow;
    }

    /**
     * Business ACCEPTED → COMPLETED.
     *
     * No notification in MVP. The customer has already physically
     * attended (that's the whole meaning of "completed"); telling
     * them they were there isn't useful. The review-prompt notification
     * lives on a separate scheduled trigger and is out of scope for
     * Phase 6.
     */
    async complete(id: string, caller: CallerContext): Promise<Appointment> {
        return this.applyTransition(id, caller, 'BUSINESS', 'COMPLETE', null, null);
    }

    // ----- Internals --------------------------------------------------------

    private async findActiveOrThrow(id: string): Promise<Appointment> {
        const row = await this.deps.appointmentsRepo.findById(id);
        if (!row || row.deletedAt !== null) {
            throw new AppointmentNotFoundError(id);
        }
        return row;
    }

    private async assertCanView(
        appointment: Appointment,
        caller: CallerContext,
    ): Promise<void> {
        if (caller.role === 'ADMIN') return;
        if (appointment.customerId === caller.userId) return;
        const business = await this.deps.businessRepo.findById(appointment.businessId);
        if (business && business.ownerUserId === caller.userId) return;
        throw new AppointmentNotOwnedError();
    }

    private async assertBusinessOwnerOrAdmin(
        businessId: string,
        caller: CallerContext,
    ): Promise<void> {
        if (caller.role === 'ADMIN') return;
        const business = await this.deps.businessRepo.findById(businessId);
        if (!business || business.ownerUserId !== caller.userId) {
            throw new AppointmentNotOwnedError();
        }
    }

    /**
     * Map a caller to the state-machine actor for an appointment:
     *   * ADMIN role → 'ADMIN'
     *   * caller is the customer → 'CUSTOMER'
     *   * caller owns the business → 'BUSINESS'
     *   * else → AppointmentNotOwnedError
     */
    private async deriveActor(
        appointment: Appointment,
        caller: CallerContext,
    ): Promise<AppointmentActor> {
        if (caller.role === 'ADMIN') return 'ADMIN';
        if (appointment.customerId === caller.userId) return 'CUSTOMER';
        const business = await this.deps.businessRepo.findById(appointment.businessId);
        if (business && business.ownerUserId === caller.userId) return 'BUSINESS';
        throw new AppointmentNotOwnedError();
    }

    /**
     * Shared body for ACCEPT / REJECT / COMPLETE — the business-only
     * transitions. CANCEL has its own method because of the cutoff
     * check + actor derivation; RESCHEDULE has its own because of the
     * slot revalidation + two-write update.
     */
    private async applyTransition(
        id: string,
        caller: CallerContext,
        actor: AppointmentActor,
        action: 'ACCEPT' | 'REJECT' | 'COMPLETE',
        cancelledBy: CancelledBy | null,
        cancelReason: string | null,
    ): Promise<Appointment> {
        const appointment = await this.findActiveOrThrow(id);

        // Business-only actions: caller must own the business (or be ADMIN).
        await this.assertBusinessOwnerOrAdmin(appointment.businessId, caller);

        const { toStatus } = assertAppointmentTransition({
            action,
            actor,
            fromStatus: appointment.status,
        });

        return this.deps.appointmentsRepo.setStatus(id, {
            status: toStatus,
            cancelledBy,
            cancelReason,
        });
    }

    private routePayment(method: PaymentMethod): PaymentGateway {
        return method === 'CASH' ? this.deps.cashGateway : this.deps.onlineGateway;
    }

    // ----- Notification fan-out --------------------------------------------

    /**
     * Send a booking notification to the business owner attached
     * to `appointment`. Resolves the business (for owner id + name)
     * and the customer (for the display name shown in
     * business-side templates), then hands off to
     * `notifyBookingEvent` for the actual dispatch + swallow.
     */
    private async notifyBusinessOwner(
        appointment: Appointment,
        templateKey: BookingTemplateKey,
        extras: NotifyExtras = {},
    ): Promise<void> {
        try {
            const business = await this.deps.businessRepo.findById(
                appointment.businessId,
            );
            if (!business) {
                this.deps.logger.warn('Skipping business notification — business not found.', {
                    appointmentId: appointment.id,
                    businessId: appointment.businessId,
                    templateKey,
                });
                return;
            }
            await this.notifyBookingEvent(
                templateKey,
                business.ownerUserId,
                appointment,
                /* needCustomerName */ true,
                extras,
                business,
            );
        } catch (err) {
            this.swallowNotifyError(err, appointment.id, templateKey);
        }
    }

    /**
     * Send a booking notification to the customer attached to
     * `appointment`. Resolves the business (for the display name
     * shown in customer-side templates) and hands off.
     */
    private async notifyCustomer(
        appointment: Appointment,
        templateKey: BookingTemplateKey,
        extras: NotifyExtras = {},
    ): Promise<void> {
        try {
            await this.notifyBookingEvent(
                templateKey,
                appointment.customerId,
                appointment,
                /* needCustomerName */ false,
                extras,
                null,
            );
        } catch (err) {
            this.swallowNotifyError(err, appointment.id, templateKey);
        }
    }

    /**
     * Shared body of the two fan-out helpers. Builds the
     * `BookingTemplatePayload` from the appointment + the
     * already-fetched (or to-be-fetched) business + service +
     * customer-display-name and calls
     * `notificationService.dispatch`.
     *
     * The dispatcher itself catches `NotificationGatewayError`
     * subclasses; the outer try/catch in `notifyBusinessOwner` /
     * `notifyCustomer` handles anything else (e.g. a thrown
     * `RepositoryError` while inserting the QUEUED log row) so
     * the booking flow is never blocked by a notification miss.
     */
    private async notifyBookingEvent(
        templateKey: BookingTemplateKey,
        recipientUserId: string,
        appointment: Appointment,
        needCustomerName: boolean,
        extras: NotifyExtras,
        preloadedBusiness: Business | null,
    ): Promise<void> {
        const businessP = preloadedBusiness
            ? Promise.resolve(preloadedBusiness)
            : this.deps.businessRepo.findById(appointment.businessId);
        const serviceP = this.deps.serviceRepo.findById(appointment.serviceId);
        const customerP = needCustomerName
            ? this.deps.userRepo.findById(appointment.customerId)
            : Promise.resolve(null);

        const [business, service, customer] = await Promise.all([
            businessP,
            serviceP,
            customerP,
        ]);

        if (!business || !service) {
            this.deps.logger.warn('Skipping booking notification — missing business or service.', {
                appointmentId: appointment.id,
                templateKey,
                businessMissing: !business,
                serviceMissing: !service,
            });
            return;
        }

        const payload: BookingTemplatePayload = {
            businessName: businessLabel(business),
            serviceName: serviceLabel(service),
            customerDisplayName: customer?.displayName ?? null,
            startsAtUtc: appointment.startsAt.toISOString(),
            cancelReason: extras.cancelReason ?? null,
            rescheduleNotes: extras.rescheduleNotes ?? null,
        };

        const channel = await this.pickNotificationChannel(
            recipientUserId,
            customer,
        );

        await this.deps.notificationService.dispatch({
            templateKey,
            recipientUserId,
            payload,
            channel,
        });
    }

    /**
     * Phase 9 — channel selection for booking-lifecycle
     * notifications. When `smsRoutingEnabled` is `true` AND the
     * recipient has a non-empty `phone`, return `'SMS'`.
     * Otherwise return `'MOCK'`. Email + Telegram routing is
     * intentionally NOT modeled here yet — those channels stay
     * on the post-Phase-9 backlog and continue to fall through
     * to `'MOCK'`.
     *
     * Optimization: when `notifyBookingEvent` has already
     * fetched the customer (the `needCustomerName=true` path),
     * and the recipient equals the customer (only true for
     * business-side templates that happen to share the same id
     * — never in MVP), we reuse that lookup. In every other
     * case we issue one extra `userRepo.findById` to pick up
     * the recipient's phone.
     *
     * When `smsRoutingEnabled` is `false`, this method short-
     * circuits without any DB call — preserving the
     * pre-Phase-9 wire cost for local-dev / docker-compose /
     * unit-test paths that don't wire an SMS gateway.
     */
    private async pickNotificationChannel(
        recipientUserId: string,
        preloadedCustomer: User | null,
    ): Promise<NotificationChannel> {
        if (!this.deps.options.smsRoutingEnabled) {
            return 'MOCK';
        }
        const recipient =
            preloadedCustomer && preloadedCustomer.id === recipientUserId
                ? preloadedCustomer
                : await this.deps.userRepo.findById(recipientUserId);

        if (recipient && typeof recipient.phone === 'string' && recipient.phone.trim() !== '') {
            return 'SMS';
        }
        return 'MOCK';
    }

    private swallowNotifyError(
        err: unknown,
        appointmentId: string,
        templateKey: BookingTemplateKey,
    ): void {
        this.deps.logger.warn('Booking notification dispatch failed (swallowed).', {
            appointmentId,
            templateKey,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

interface NotifyExtras {
    readonly cancelReason?: string | null;
    readonly rescheduleNotes?: string | null;
}

function businessLabel(business: Business): string {
    return business.name ?? 'your business';
}

function serviceLabel(service: Service): string {
    return service.name.en;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIsoUtc(raw: string): Date {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new AppointmentInvalidStartTimeError(raw);
    }
    return parsed;
}

/**
 * Duck-typed check for a pg `Error` carrying SQLSTATE `23P01`
 * (`exclusion_violation`). The repository deliberately lets these
 * escape so the service layer can translate them to
 * `AppointmentSlotUnavailableError`.
 */
function isExclusionViolation(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: unknown }).code === PG_EXCLUSION_VIOLATION
    );
}
