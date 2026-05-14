# ADR-0004: S3 for media storage with signed-URL uploads

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** EthioLink core team

## Context

Businesses will upload profile photos, cover photos, and service images. Customers may upload profile images. We need durable storage with predictable per-GB costs, the ability to serve images directly to mobile clients without proxying through our compute layer, and the ability to keep private uploads behind authorization.

Options considered:

- **EFS or EBS volumes** — wrong tool for the job.
- **CloudFront with origin = ALB + Lambda** — adds complexity we do not need.
- **S3** — the obvious answer; durable, cheap, and well-supported by AWS SDKs and CDNs.

## Decision

Use **Amazon S3** for all media storage, with three buckets per environment:

- `ethiolink-${env}-media-public` — public-read assets such as business cover photos. Served either via direct S3 URLs or, later, CloudFront.
- `ethiolink-${env}-media-private` — private assets, served via short-lived pre-signed GET URLs.
- `ethiolink-${env}-logs` — access logs from the other buckets.

**Uploads** use pre-signed PUT URLs issued by the API. The client uploads directly to S3, then calls a confirm endpoint that persists a `media_assets` row. This keeps large transfers off the Lambda compute path.

A `StorageGateway` interface in `backend/shared/adapters/storage/` wraps all S3 calls. The service layer never imports the AWS SDK directly.

## Consequences

**Positive:**

- Direct uploads avoid Lambda payload size limits and reduce cost.
- 11-nines durability and effectively unlimited scale.
- Public-read URL pattern is simple to consume from Flutter and React.

**Negative:**

- Misconfigured bucket policies are a real risk. Public-read is restricted to the single `*-media-public` bucket; all other buckets block public access at the account level.
- Pre-signed URL expiry needs careful selection — short enough to be safe, long enough that Ethiopian mobile networks can complete the upload. Default is 15 minutes for upload, 1 hour for read.
- Listing media for a business requires keeping a `media_assets` table in sync with S3 contents; we accept that complexity in exchange for the ability to attach metadata.
