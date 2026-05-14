// EthioLink — appointment state machine unit tests.
//
// `assertAppointmentTransition` is a pure function over a static
// matrix. The tests:
//   1. walk every row of `APPOINTMENT_TRANSITIONS` and assert the
//      function returns the expected `toStatus`;
//   2. probe a representative sample of disallowed triples and assert
//      `InvalidAppointmentTransitionError` is raised;
//   3. confirm the terminal-status set is exactly the four statuses
//      that have no outgoing transitions.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppointmentStatus } from '../../shared/domains/appointments/appointmentsRepository.js';
import {
    APPOINTMENT_TRANSITIONS,
    type AppointmentAction,
    type AppointmentActor,
    InvalidAppointmentTransitionError,
    TERMINAL_APPOINTMENT_STATUSES,
    assertAppointmentTransition,
    isTerminalAppointmentStatus,
} from '../../shared/domains/appointments/appointmentStateMachine.js';

const ALL_STATUSES: readonly AppointmentStatus[] = [
    'REQUESTED',
    'ACCEPTED',
    'REJECTED',
    'CANCELLED',
    'COMPLETED',
    'NO_SHOW',
];

const ALL_ACTIONS: readonly AppointmentAction[] = [
    'ACCEPT',
    'REJECT',
    'CANCEL',
    'RESCHEDULE',
    'COMPLETE',
];

const ALL_ACTORS: readonly AppointmentActor[] = ['CUSTOMER', 'BUSINESS', 'ADMIN'];

describe('assertAppointmentTransition — allowed transitions (matrix walk)', () => {
    for (const rule of APPOINTMENT_TRANSITIONS) {
        for (const actor of rule.actors) {
            it(`${rule.action} by ${actor} from ${rule.fromStatus} → ${rule.toStatus}`, () => {
                const result = assertAppointmentTransition({
                    action: rule.action,
                    actor,
                    fromStatus: rule.fromStatus,
                });
                assert.deepStrictEqual(result, {
                    action: rule.action,
                    actor,
                    fromStatus: rule.fromStatus,
                    toStatus: rule.toStatus,
                });
            });
        }
    }
});

describe('assertAppointmentTransition — disallowed actor / status combos', () => {
    const cases: Array<{
        readonly action: AppointmentAction;
        readonly actor: AppointmentActor;
        readonly fromStatus: AppointmentStatus;
    }> = [
        // Business-only actions attempted by a customer or admin.
        { action: 'ACCEPT', actor: 'CUSTOMER', fromStatus: 'REQUESTED' },
        { action: 'ACCEPT', actor: 'ADMIN', fromStatus: 'REQUESTED' },
        { action: 'REJECT', actor: 'CUSTOMER', fromStatus: 'REQUESTED' },
        { action: 'COMPLETE', actor: 'CUSTOMER', fromStatus: 'ACCEPTED' },
        { action: 'COMPLETE', actor: 'ADMIN', fromStatus: 'ACCEPTED' },

        // Reschedule is customer-only in MVP.
        { action: 'RESCHEDULE', actor: 'BUSINESS', fromStatus: 'REQUESTED' },
        { action: 'RESCHEDULE', actor: 'ADMIN', fromStatus: 'ACCEPTED' },

        // Right action / actor, wrong fromStatus.
        { action: 'ACCEPT', actor: 'BUSINESS', fromStatus: 'ACCEPTED' },
        { action: 'COMPLETE', actor: 'BUSINESS', fromStatus: 'REQUESTED' },
        { action: 'CANCEL', actor: 'CUSTOMER', fromStatus: 'COMPLETED' },
        { action: 'RESCHEDULE', actor: 'CUSTOMER', fromStatus: 'CANCELLED' },
    ];

    for (const c of cases) {
        it(`refuses ${c.action} by ${c.actor} from ${c.fromStatus}`, () => {
            assert.throws(
                () => assertAppointmentTransition(c),
                (err: unknown) => {
                    assert.ok(
                        err instanceof InvalidAppointmentTransitionError,
                        `got ${err}`,
                    );
                    assert.strictEqual(err.action, c.action);
                    assert.strictEqual(err.actor, c.actor);
                    assert.strictEqual(err.fromStatus, c.fromStatus);
                    return true;
                },
            );
        });
    }
});

describe('assertAppointmentTransition — terminal statuses are sealed', () => {
    for (const status of ['REJECTED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] as const) {
        for (const action of ALL_ACTIONS) {
            for (const actor of ALL_ACTORS) {
                it(`refuses ${action} by ${actor} from terminal ${status}`, () => {
                    assert.throws(
                        () =>
                            assertAppointmentTransition({
                                action,
                                actor,
                                fromStatus: status,
                            }),
                        InvalidAppointmentTransitionError,
                    );
                });
            }
        }
    }
});

describe('isTerminalAppointmentStatus', () => {
    it('returns true for every status in TERMINAL_APPOINTMENT_STATUSES', () => {
        for (const status of TERMINAL_APPOINTMENT_STATUSES) {
            assert.strictEqual(isTerminalAppointmentStatus(status), true, status);
        }
    });

    it('returns false for REQUESTED and ACCEPTED', () => {
        assert.strictEqual(isTerminalAppointmentStatus('REQUESTED'), false);
        assert.strictEqual(isTerminalAppointmentStatus('ACCEPTED'), false);
    });

    it('classifies every status exactly once', () => {
        // Sanity: every status is either active (has at least one
        // outgoing transition) or terminal — never both, never
        // neither.
        for (const status of ALL_STATUSES) {
            const hasOutgoing = APPOINTMENT_TRANSITIONS.some(
                (rule) => rule.fromStatus === status,
            );
            const isTerminal = isTerminalAppointmentStatus(status);
            assert.notStrictEqual(
                hasOutgoing,
                isTerminal,
                `${status} should be exactly one of active / terminal`,
            );
        }
    });
});

describe('APPOINTMENT_TRANSITIONS matrix integrity', () => {
    it('contains exactly the seven (action+fromStatus) pairs documented in PHASE_4_BOOKING.md', () => {
        // (action, fromStatus) pairs covered. Multiple actors on the
        // same pair (e.g. CANCEL from REQUESTED) collapse to one row.
        const pairs = new Set(
            APPOINTMENT_TRANSITIONS.map((r) => `${r.action}:${r.fromStatus}`),
        );
        assert.deepStrictEqual(
            [...pairs].sort(),
            [
                'ACCEPT:REQUESTED',
                'CANCEL:ACCEPTED',
                'CANCEL:REQUESTED',
                'COMPLETE:ACCEPTED',
                'REJECT:REQUESTED',
                'RESCHEDULE:ACCEPTED',
                'RESCHEDULE:REQUESTED',
            ],
        );
    });

    it('never produces NO_SHOW as a transition target in MVP', () => {
        for (const rule of APPOINTMENT_TRANSITIONS) {
            assert.notStrictEqual(rule.toStatus, 'NO_SHOW', rule.action);
        }
    });
});
