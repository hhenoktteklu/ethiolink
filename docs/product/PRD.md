# Product Requirements Document — EthioLink

## 1. Vision

EthioLink is a mobile-first marketplace platform built for Ethiopia. The long-term vision is a multi-category marketplace covering beauty services, event ticketing, physical product commerce, and vehicle listings. We start narrow and earn the right to expand.

## 2. MVP product: beauty appointment booking

The initial product is a two-sided marketplace connecting Ethiopian customers with beauty providers — salons, barbers, spas, and independent beauty professionals.

### 2.1 Why beauty first

- Strong, persistent demand in Addis Ababa and regional cities.
- Existing providers manage bookings by phone, Telegram, and walk-ins, leaving room for a structured booking tool to add real value.
- Booking is a tractable, well-understood unit of work — ideal first vertical to validate the platform's core mechanics before expanding.

### 2.2 User personas

**Customer (mobile-first).** A young to middle-aged Ethiopian who wants to discover and book beauty services without phoning around. Often on patchy mobile data; English-literate, Amharic-preferred over time.

**Business owner (mobile-first, occasionally desktop).** Owns or manages a salon, barbershop, spa, or operates as an independent professional. Needs a simple way to publish services, manage staff availability, and accept bookings without a steep learning curve.

**Admin (desktop).** Anthropic-side or partner-side operations staff who approve businesses, manage categories, and intervene when needed.

## 3. Goals

1. Let customers discover and book a beauty appointment in under two minutes on a low-end Android phone.
2. Let businesses publish their offering and accept bookings within an hour of signup.
3. Give admins enough control to keep marketplace quality high during the early-trust phase.
4. Ship architecture that scales horizontally to additional marketplace verticals without re-platforming.

## 4. Non-goals (for MVP)

- Online payment processing — payments stay cash-first with placeholders for future integration (Telebirr, Chapa, CBE Birr).
- Event ticketing, product commerce, vehicle listings — explicitly deferred.
- Native Amharic UI — the data model and copy structure must be Amharic-ready, but the MVP ships English-only.
- Loyalty programs, gift cards, multi-location chain management beyond the basics, automated marketing tools.
- In-app chat between customers and businesses — Telegram/WhatsApp share-out is enough for MVP.

## 5. Key user journeys

### Customer

1. Open app → browse categories or search by service/location.
2. Filter by category, service, location, price band, rating.
3. View business profile (services, prices, photos, staff, reviews).
4. Pick a service, staff member, date, and time.
5. Confirm booking (payment defaults to cash).
6. Receive confirmation and reminders.
7. Optionally cancel or reschedule before the appointment window.
8. After visit, leave a review.

### Business owner

1. Register and create a business profile (name, category, location, photos).
2. Submit for admin approval.
3. Once approved, add services, staff, and availability.
4. Receive incoming bookings, accept or reject them.
5. Track upcoming appointments on a simple dashboard.

### Admin

1. Log in to the admin dashboard.
2. Review pending businesses and approve or reject with notes.
3. Manage marketplace categories and featured listings.
4. Investigate users or bookings when something goes wrong.

## 6. Success metrics (first 90 days post-launch)

- ≥ 200 approved businesses live on the platform.
- ≥ 1,000 customers registered.
- ≥ 500 completed bookings.
- ≥ 70% of bookings receive a customer review within 7 days.
- Median time-to-first-booking for a new business: under 24 hours after approval.

## 7. Constraints

- Mobile data is expensive and unreliable in much of Ethiopia. Pages must work on slow 3G and recover gracefully from dropped connections.
- Most users will not have a credit card. Cash-on-arrival is the default; online payments are a planned future addition behind a clean abstraction.
- SMS and Telegram are the dominant notification channels; email is secondary.
- The platform must be ready to operate under intermittent internet conditions on the business side as well as the customer side.

## 8. Compliance and trust

- Businesses are admin-approved before going public to keep the early marketplace high-quality.
- Customer reviews are tied to completed bookings only.
- Personal data handling follows Ethiopian data-protection norms and we keep storage in the closest available AWS region.
