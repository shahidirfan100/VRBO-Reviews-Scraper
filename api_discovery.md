## Selected API
- Endpoint: https://www.expedia.com/graphql
- Method: POST
- Auth: No explicit auth token required, but anti-bot controls require realistic headers/session cookies and strong proxy hygiene.
- Pagination: `pageIndex` and `size` are passed in GraphQL variables.
- Fields available: `id`, `disclaimer`, `summary.primary`, `summary.secondary`, `summary.accessibilityLabel`, `review.title`, `review.text`, `managementResponses`, `tripSummary`, `sentiments`, plus pagination metadata.
- Fields currently missing in actor: richer normalized numeric ratings, stay dates, and traveler profile details (not always present in this response shape).
- Field count: 15+ extracted output fields (more than the prior minimal review-text approach).

## Discovery Notes
- URLScan domain search used: `https://urlscan.io/api/v1/search/?q=page.url:"https://www.vrbo.com/*"`
- Relevant scan inspected: `019d7e92-ec93-7084-a80e-c681c3aaa2f2`
- Observed traffic confirms Expedia platform-backed property pages and JSON-heavy network activity.

## Candidate Ranking
1. Expedia GraphQL reviews endpoint (`/graphql`) — selected
- Returns structured review payloads and supports page-based pagination.
- Replays with `gotScraping` when request context is hardened (headers + warmup cookie + proxy).
- Matches and extends existing actor output fields.

2. JSON-LD hydration (`script[type="application/ld+json"]`) — fallback
- Public structured data source, usually lighter than GraphQL.
- Lower field richness and often fewer review rows.

3. Generic HTML DOM extraction — rejected
- Less stable and weaker data quality than direct JSON sources.

## Scoring
- Returns JSON directly: +30
- Has >15 unique fields: +25
- No explicit auth token required: +20
- Supports pagination: +15
- Matches/extends current fields: +10
- Total: 100

## Why Other Candidates Were Rejected
- JSON-LD was retained only as fallback because it often exposes fewer fields and fewer review records.
- Pure HTML parsing was rejected due to fragility and lower reliability under template/layout changes.

## Operational Requirements
- Works with plain `gotScraping`, but robust runs need:
  - realistic browser-like headers,
  - a session warmup request for cookies,
  - sticky proxy session,
  - residential proxy for protected properties.
- Actor remains API-first and only falls back to structured page JSON when GraphQL is blocked.