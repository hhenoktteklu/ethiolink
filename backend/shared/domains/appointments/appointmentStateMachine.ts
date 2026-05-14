// EthioLink — appointment state machine.
//
// Pure-function gate that the booking service consults before any
// status-changing operation. Given (action, actor, fromStatus), it
// either returns the resulting `toStatus` or throws a typed
// `InvalidAppointmentTransitionError`. No DB, no I/O — every call
// resolves synchronously off a static matrix.
//
// Why a separate module:
//   * The state machine is the canonical source of "which transitions
//     are legal". Service code, future admin tooling, and tests all
//     consult the same matrix. Drift between code paths is impossible
//     because there is only one matrix.
//   * Pure functions are trivially unit-testable. The booking service
//     gets to focus on side effects (DB writes, exclusion-violation
//     handling, payment dispatch) without re-litigating transition
//     rules.
//   * Keeping the actor in the call signature (CUSTOMER / BUSINESS /
//     ADMIN) makes the per-actor rules explicit and lets the booking
//     service reuse the same primitive for "customer cancels mine",
//     "business cancels theirs", and "admin override".
//
// Transition matrix (see PHASE_4_BOOKING.md "State machine"):
//
//   ACCEPT    | BUSINESS                | REQUESTED → ACCEPTED
//   REJECT    | BUSINESS                | REQUESTED → REJECTED
//   CANCEL    | CUSTOMER, BUSINESS, ADMIN | REQUESTED → CANCELLED
//   CANCEL    | CUSTOMER, BUSINESS, ADMIN | ACCEPTED  → CANCELLED
//   RESCHEDULE| CUSTOMER                | REQUESTED → REQUESTED
//   RESCHEDULE| CUSTOMER                | ACCEPTED  → REQUESTED
//   COMPLETE  | BUSINESS                | ACCEPTED  → COMPLETED
//
// Notes:
//   * `RESCHEDULE` from ACCEPTED resets the status to REQUESTED — a
//     reschedule moves the time window, so the business must
//     re-accept. From REQUESTED, the toStatus is unchanged
//     (REQUESTED → REQUESTED). The service still records the new
//     time on the row.
//   * `NO_SHOW` is in `AppointmentStatus` for forward compatibility
//     (migration 0009 reserves it in the CHECK list) but has no
//     allowed transition in MVP — no public endpoint yet. Any attempt
//     to transition out of NO_SHOW raises
//     `InvalidAppointmentTransitionError`, same as the other terminal
//     states.
//   * Admin cancellation bypasses the 4-hour cancellation cutoff that
//     the booking service enforces against customers. The state
//     machine does NOT know about the cutoff — it only knows whether
//     the transition is legal. The cutoff is layered above this
//     primitive in `appointmentService`.
//   * The state machine has no opinion about the cancellation
//     metadata (`cancelled_by`, `cancel_reason`). The service maps
//     `actor → cancelled_by` and pulls `cancel_reason` off the
//     request body.

import type { AppointmentStatus } from './appointmentsRepository.js';

/** Action requested by the caller. */
export type AppointmentAction =
    | 'ACCEPT'
    | 'REJECT'
    | 'CANCEL'
    | 'RESCHEDULE'
    | 'COMPLETE';

/** Who is initiating the action. Authorization is a separate concern. */
export type AppointmentActor = 'CUSTOMER' | 'BUSINESS' | 'ADMIN';

/** Input for {@link assertAppointmentTransition}. */
export interface AppointmentTransitionInput {
    readonly action: AppointmentAction;
    readonly actor: AppointmentActor;
    readonly fromStatus: AppointmentStatus;
}

/** Result returned on a legal transition. */
export interface AppointmentTransitionResult {
    readonly action: AppointmentAction;
    readonly actor: AppointmentActor;
    readonly fromStatus: AppointmentStatus;
    readonly toStatus: AppointmentStatus;
}

/**
 * Raised when the (action, actor, fromStatus) triple is not in the
 * allowed-transitions matrix. The booking service maps this to a
 * `CONFLICT` HTTP response (the appointment cannot move in the
 * requested direction); authorization-style rejections happen above
 * this layer.
 */
export class InvalidAppointmentTransitionError extends Error {
    public readonly action: AppointmentAction;
    public readonly actor: AppointmentActor;
    public readonly fromStatus: AppointmentStatus;

    constructor(input: AppointmentTransitionInput) {
        super(
            `Action ${input.action} by ${input.actor} is not allowed ` +
                `from status ${input.fromStatus}.`,
        );
        this.name = 'InvalidAppointmentTransitionError';
        this.action = input.action;
        this.actor = input.actor;
        this.fromStatus = input.fromStatus;
    }
}

// ---------------------------------------------------------------------------
// Transition matrix
// ---------------------------------------------------------------------------

/**
 * Each row is one allowed transition. The matrix is the single source
 * of truth — `assertAppointmentTransition` and the unit tests both
 * read from it directly so they cannot drift apart.
 */
export interface AppointmentTransitionRule {
    readonly action: AppointmentAction;
    /** Actors permitted to take this action from this fromStatus. */
    readonly actors: readonly AppointmentActor[];
    readonly fromStatus: AppointmentStatus;
    readonly toStatus: AppointmentStatus;
}

export const APPOINTMENT_TRANSITIONS: readonly AppointmentTransitionRule[] = Object.freeze([
    // Business workflow on a new booking.
    { action: 'ACCEPT', actors: ['BUSINESS'], fromStatus: 'REQUESTED', toStatus: 'ACCEPTED' },
    { action: 'REJECT', actors: ['BUSINESS'], fromStatus: 'REQUESTED', toStatus: 'REJECTED' },

    // Cancellation. Customer, business, and admin can all initiate;
    // the booking service enforces the 4-hour cutoff against
    // customers (admin override skips it).
    {
        action: 'CANCEL',
        actors: ['CUSTOMER', 'BUSINESS', 'ADMIN'],
        fromStatus: 'REQUESTED',
        toStatus: 'CANCELLED',
    },
    {
        action: 'CANCEL',
        actors: ['CUSTOMER', 'BUSINESS', 'ADMIN'],
        fromStatus: 'ACCEPTED',
        toStatus: 'CANCELLED',
    },

    // Reschedule resets the business-side confirmation: any reschedule
    // sends the row back to REQUESTED for re-acceptance.
    {
        action: 'RESCHEDULE',
        actors: ['CUSTOMER'],
        fromStatus: 'REQUESTED',
        toStatus: 'REQUESTED',
    },
    {
        action: 'RESCHEDULE',
        actors: ['CUSTOMER'],
        fromStatus: 'ACCEPTED',
        toStatus: 'REQUESTED',
    },

    // Completion is business-only and only valid from ACCEPTED.
    { action: 'COMPLETE', actors: ['BUSINESS'], fromStatus: 'ACCEPTED', toStatus: 'COMPLETED' },
] as const);

/** Terminal statuses — no outgoing transitions in MVP. */
export const TERMINAL_APPOINTMENT_STATUSES: ReadonlySet<AppointmentStatus> = Object.freeze(
    new Set<AppointmentStatus>(['REJECTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']),
);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Validate a requested transition and return the resulting state.
 *
 * Throws {@link InvalidAppointmentTransitionError} if no rule in the
 * matrix matches the (action, actor, fromStatus) triple.
 */
export function assertAppointmentTransition(
    input: AppointmentTransitionInput,
): AppointmentTransitionResult {
    const match = APPOINTMENT_TRANSITIONS.find(
        (rule) =>
            rule.action === input.action &&
            rule.fromStatus === input.fromStatus &&
            rule.actors.includes(input.actor),
    );
    if (!match) {
        throw new InvalidAppointmentTransitionError(input);
    }
    return Object.freeze<AppointmentTransitionResult>({
        action: input.action,
        actor: input.actor,
        fromStatus: input.fromStatus,
        toStatus: match.toStatus,
    });
}

/**
 * True iff the status has no outgoing transitions in MVP. Useful for
 * callers that want to short-circuit before assembling a transition
 * input (e.g., admin listings that grey out terminal rows).
 */
export function isTerminalAppointmentStatus(status: AppointmentStatus): boolean {
    return TERMINAL_APPOINTMENT_STATUSES.has(status);
}
