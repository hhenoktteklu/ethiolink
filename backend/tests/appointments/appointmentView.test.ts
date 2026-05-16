// EthioLink — AppointmentView + CreateAppointmentResponse tests.
//
// Phase 10 first-routing commit. Two surfaces:
//
//   * `toAppointmentView` — pure projection; sanity check the
//     timestamp + payload shape across the booking lifecycle.
//   * `toCreateAppointmentResponse` — wraps the appointment with a
//     `payment` block carrying redirectUrl / status / providerRef.
//     Cash bookings ship `redirectUrl: null`; Chapa-style PENDING
//     bookings ship the hosted-checkout URL verbatim.
//
// View-layer only; no DB, no service, no handler.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PaymentAuthorization } from '../../shared/adapters/payments/PaymentGateway.js';
import type { Appointment } from '../../shared/domains/appointments/appointmentsRepository.js';
import {
    toAppointmentView,
    toCreateAppointmentResponse,
} from '../../shared/domains/appointments/appointmentView.js';

const SAMPLE_APPOINTMENT: Appointment = Object.freeze<Appointment>({
    id: '00000000-0000-0000-0000-000000000001',
    customerId: '00000000-0000-0000-0000-00000000c001',
    businessId: '00000000-0000-0000-0000-0000000000b1',
    serviceId: '00000000-0000-0000-0000-000000000051',
    staffId: '00000000-0000-0000-0000-00000000ff01',
    startsAt: new Date('2026-06-15T10:00:00.000Z'),
    endsAt: new Date('2026-06-15T10:30:00.000Z'),
    status: 'REQUESTED',
    paymentMethod: 'CASH',
    priceEtb: 300,
    notes: null,
    cancelledBy: null,
    cancelReason: null,
    deletedAt: null,
    createdAt: new Date('2026-06-15T08:00:00.000Z'),
    updatedAt: new Date('2026-06-15T08:00:00.000Z'),
});

const CASH_AUTH: PaymentAuthorization = Object.freeze<PaymentAuthorization>({
    status: 'SUCCEEDED',
    provider: 'CASH',
    providerRef: null,
    rawResponse: null,
    errorCode: null,
    errorMessage: null,
    authorizedAt: '2026-06-15T08:00:00.000Z',
    redirectUrl: null,
});

const CHAPA_PENDING_AUTH: PaymentAuthorization = Object.freeze<PaymentAuthorization>({
    status: 'PENDING',
    provider: 'CHAPA',
    providerRef: 'apt-00000000-12345678',
    rawResponse: { status: 'success' },
    errorCode: null,
    errorMessage: null,
    authorizedAt: '2026-06-15T08:00:00.000Z',
    redirectUrl: 'https://checkout.chapa.test/sess-001',
});

const CHAPA_FAILED_AUTH: PaymentAuthorization = Object.freeze<PaymentAuthorization>({
    status: 'FAILED',
    provider: 'CHAPA',
    providerRef: 'apt-00000000-12345678',
    rawResponse: { status: 'failed' },
    errorCode: 'CHAPA_DECLINED',
    errorMessage: 'Insufficient funds',
    authorizedAt: '2026-06-15T08:00:00.000Z',
    redirectUrl: null,
});

describe('toAppointmentView', () => {
    it('emits ISO-8601 timestamps + the full domain field set', () => {
        const view = toAppointmentView(SAMPLE_APPOINTMENT);
        assert.strictEqual(view.id, SAMPLE_APPOINTMENT.id);
        assert.strictEqual(view.startsAt, '2026-06-15T10:00:00.000Z');
        assert.strictEqual(view.endsAt, '2026-06-15T10:30:00.000Z');
        assert.strictEqual(view.status, 'REQUESTED');
        assert.strictEqual(view.paymentMethod, 'CASH');
        assert.strictEqual(view.priceEtb, 300);
        assert.strictEqual(view.notes, null);
        assert.strictEqual(view.cancelledBy, null);
    });

    it('does not leak deletedAt or the redirectUrl field', () => {
        const view = toAppointmentView(SAMPLE_APPOINTMENT) as unknown as Record<
            string,
            unknown
        >;
        assert.strictEqual(view.deletedAt, undefined);
        // Phase 10: redirect URL belongs on the create-response
        // wrapper, NOT the bare appointment view.
        assert.strictEqual(view.redirectUrl, undefined);
        assert.strictEqual(view.payment, undefined);
    });
});

describe('toCreateAppointmentResponse — Phase 10 wire wrapper', () => {
    it('cash booking → payment.redirectUrl: null, status SUCCEEDED', () => {
        const response = toCreateAppointmentResponse(
            SAMPLE_APPOINTMENT,
            CASH_AUTH,
        );
        assert.strictEqual(response.appointment.id, SAMPLE_APPOINTMENT.id);
        assert.strictEqual(response.payment.status, 'SUCCEEDED');
        assert.strictEqual(response.payment.provider, 'CASH');
        assert.strictEqual(response.payment.redirectUrl, null);
        assert.strictEqual(response.payment.providerRef, null);
        assert.strictEqual(response.payment.errorCode, null);
        assert.strictEqual(response.payment.errorMessage, null);
    });

    it('Chapa PENDING booking → payment.redirectUrl carries hosted checkout', () => {
        const response = toCreateAppointmentResponse(
            SAMPLE_APPOINTMENT,
            CHAPA_PENDING_AUTH,
        );
        assert.strictEqual(response.payment.status, 'PENDING');
        assert.strictEqual(response.payment.provider, 'CHAPA');
        assert.strictEqual(
            response.payment.redirectUrl,
            'https://checkout.chapa.test/sess-001',
        );
        assert.strictEqual(
            response.payment.providerRef,
            'apt-00000000-12345678',
        );
    });

    it('Chapa FAILED booking → payment carries errorCode + errorMessage', () => {
        const response = toCreateAppointmentResponse(
            SAMPLE_APPOINTMENT,
            CHAPA_FAILED_AUTH,
        );
        assert.strictEqual(response.payment.status, 'FAILED');
        assert.strictEqual(response.payment.errorCode, 'CHAPA_DECLINED');
        assert.strictEqual(response.payment.errorMessage, 'Insufficient funds');
        assert.strictEqual(response.payment.redirectUrl, null);
    });

    it('does not leak rawResponse or authorizedAt on the wire', () => {
        const response = toCreateAppointmentResponse(
            SAMPLE_APPOINTMENT,
            CHAPA_PENDING_AUTH,
        ) as unknown as { payment: Record<string, unknown> };
        assert.strictEqual(response.payment.rawResponse, undefined);
        assert.strictEqual(response.payment.authorizedAt, undefined);
    });

    it('appointment field equals toAppointmentView(...)', () => {
        const response = toCreateAppointmentResponse(
            SAMPLE_APPOINTMENT,
            CASH_AUTH,
        );
        const standalone = toAppointmentView(SAMPLE_APPOINTMENT);
        assert.deepStrictEqual(response.appointment, standalone);
    });
});
