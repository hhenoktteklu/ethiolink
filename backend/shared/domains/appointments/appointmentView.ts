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
