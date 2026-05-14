# MVP Scope

This document is the contract for what is **in** and what is **out** of the MVP. Anything not listed here is out of scope for v1.

## In scope — customer

- Register and log in (Cognito-backed).
- Browse salons, barbers, spas, and beauty professionals.
- Search and filter by category, service, location, price, rating.
- View a business profile: services, prices, photos, staff, reviews.
- Book an appointment for a specific service, staff member, date, and time.
- Cancel or reschedule a booking before its cutoff.
- Payment selection placeholder: cash (functional), online (UI-present, disabled).
- Share a business profile via Telegram or WhatsApp link.
- Leave a review after a completed booking.

## In scope — business

- Register and log in (Cognito-backed).
- Create a business profile with category, location, description, photos.
- Submit profile for admin approval.
- Add, edit, and remove services with name, duration, price.
- Add, edit, and remove staff members.
- Set staff availability (weekly recurring schedule + ad-hoc overrides).
- View incoming booking requests.
- Accept or reject bookings.
- Basic dashboard view: upcoming appointments, recent activity.

## In scope — admin

- Log in (Cognito-backed, ADMIN role).
- Approve or reject pending businesses with optional notes.
- View and manage all users.
- View and manage all businesses.
- Manage marketplace categories.
- View all bookings (read-only).
- Manually feature or unfeature listings.

## In scope — platform

- Mobile-first UI (Flutter for customers and businesses).
- English copy, with all strings externalized to enable Amharic later.
- Cash payment flow functional end-to-end; online payment is an abstraction stub.
- SMS, email, and Telegram notifications behind a provider abstraction (mock provider in MVP, with hooks for Ethiopian SMS providers later).
- Signed-URL S3 uploads for profile photos and media assets.

## Out of scope — explicitly deferred

- Event ticketing module.
- Product marketplace module.
- Car dealership listings module.
- Real online payment integration (Telebirr, Chapa, CBE Birr).
- In-app chat between customers and businesses.
- Loyalty programs, vouchers, discount codes.
- Multi-currency support beyond ETB.
- Native Amharic UI (data layer is Amharic-ready; UI strings stay English for v1).
- Push notifications via FCM/APNs at MVP launch (planned for Phase 6+).
- Social login (Google, Apple, Facebook) — Cognito email/phone only.

## Out of scope — never

- Cryptocurrency payments.
- Reviews not tied to a completed booking.

## Definition of "MVP done"

The MVP is done when all of the following are true:

1. A new customer can install the app, sign up, find a salon, and book an appointment end-to-end.
2. A new business can sign up, get approved, publish services, and accept a booking.
3. An admin can approve a business and feature a listing from the web dashboard.
4. Cash bookings are recorded, confirmed by the business, and surface in the customer's history.
5. All MVP infrastructure is provisioned through Terraform and deployable to a fresh AWS account.
6. CloudWatch dashboards and alarms exist for API errors, Lambda failures, and RDS health.
