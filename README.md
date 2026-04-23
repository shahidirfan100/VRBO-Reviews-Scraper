# VRBO Reviews Scraper

Collect detailed guest review data from VRBO property listings in a clean, analysis-ready dataset. Capture review text, author context, sentiment labels, manager responses, and supporting metadata in one run. Ideal for hospitality intelligence, property benchmarking, and reputation tracking.

## Features

- **Flexible property targeting** — Use either a listing URL or direct property identifier.
- **Rich review coverage** — Extract review body, titles, labels, trip summaries, and response notes.
- **Duplicate-safe output** — Automatically filters repeated records across paginated pages and fallback sources.
- **Null-free datasets** — Removes empty values so exports are clean for BI tools and spreadsheets.
- **Resilient collection flow** — Falls back to structured page data when primary review stream is limited.

## Use Cases

### Reputation Monitoring
Track recurring complaints, praise themes, and response quality across individual properties. Identify service gaps before they impact occupancy.

### Competitive Benchmarking
Compare guest sentiment and feedback depth between properties in the same market. Use output fields to build side-by-side quality scorecards.

### Hospitality Analytics
Build structured review datasets for dashboards, trend analysis, and quarterly reporting. Connect scraped output to your internal performance KPIs.

### Portfolio Operations
Audit large property portfolios to detect review-quality outliers quickly. Prioritize operational fixes based on review volume and sentiment context.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | String | No | — | VRBO or Expedia property URL. |
| `propertyId` | String | No | — | Direct property identifier. Takes priority when provided. |
| `results_wanted` | Integer | No | `20` | Maximum review rows to return. |
| `max_pages` | Integer | No | `10` | Maximum pages to request during pagination. |
| `locale` | String | No | `en_US` | Locale context for localized review content. |
| `currency` | String | No | `USD` | Currency context for localization consistency. |
| `proxyConfiguration` | Object | No | `{ "useApifyProxy": true }` | Proxy settings for reliability on protected pages. |

## Output Data

Each dataset item can contain:

| Field | Type | Description |
|---|---|---|
| `property_id` | String | Resolved property identifier. |
| `review_id` | String | Unique review identifier when available. |
| `rating_label` | String | Rating or score label from source data. |
| `author` | String | Guest/author display name. |
| `title` | String | Review title or heading. |
| `review_text` | String | Main review text content. |
| `summary_accessibility` | String | Supplemental summary/accessibility text. |
| `trip_summary` | String | Trip context summary text when present. |
| `sentiments` | Array | Sentiment labels attached to review content. |
| `management_response` | String | Host/manager response content. |
| `disclaimer` | String | Source disclaimer or attribution text. |
| `page_index` | Integer | Page index where the review was collected. |
| `position` | Integer | Position of item within that page/source batch. |
| `source_type` | String | Source stream used for the record. |
| `source_url` | String | Source endpoint or page reference. |
| `input_url` | String | Original property URL context. |
| `scraped_at` | String | ISO timestamp of extraction. |

## Usage Examples

### Basic Property Run

```json
{
	"url": "https://www.vrbo.com/32650537",
	"results_wanted": 20
}
```

### Direct Property ID Run

```json
{
	"propertyId": "32650537",
	"results_wanted": 50,
	"max_pages": 10
}
```

### Stable Production Run

```json
{
	"url": "https://www.vrbo.com/32650537",
	"results_wanted": 100,
	"max_pages": 20,
	"proxyConfiguration": {
		"useApifyProxy": true,
		"apifyProxyGroups": ["RESIDENTIAL"]
	}
}
```

## Sample Output

```json
{
	"property_id": "32650537",
	"review_id": "bc2fa4f7-7e66-4dc5-8d59-9e7a893c1ef4",
	"rating_label": "10 out of 10",
	"author": "Verified traveler",
	"title": "Great location and clean home",
	"review_text": "The house was spotless and close to everything we needed. Host communication was excellent.",
	"summary_accessibility": "Rated 10 out of 10",
	"trip_summary": "Family trip",
	"sentiments": [
		"Cleanliness",
		"Location",
		"Communication"
	],
	"management_response": "Thank you for staying with us! We would love to host you again.",
	"page_index": 0,
	"position": 3,
	"source_type": "productReviewDetails",
	"source_url": "https://www.expedia.com/graphql",
	"input_url": "https://www.vrbo.com/32650537",
	"scraped_at": "2026-04-23T12:34:56.000Z"
}
```

## Tips for Best Results

### Prefer Canonical Property Links
- Use direct listing links when possible.
- Keep query strings minimal unless they include property identifiers.

### Tune Result Limits Gradually
- Start with 20-50 rows for validation.
- Increase limits only after confirming stable output for target properties.

### Use Residential Proxies for Protected Targets
- Residential pools improve completion rates.
- Keep concurrency moderate to reduce temporary rate-limit responses.

## Integrations

- **Google Sheets** — Build quick review trackers and share with operations teams.
- **Airtable** — Create searchable guest-feedback databases by property.
- **Slack** — Notify teams when new review batches are collected.
- **Make** — Trigger follow-up automations from fresh datasets.
- **Zapier** — Sync records into CRM, PM, or reporting tools.

### Export Formats

- **JSON** — Best for APIs and engineering workflows.
- **CSV** — Spreadsheet-ready for analysts and ops teams.
- **Excel** — Executive reporting and ad hoc review.
- **XML** — Legacy system integrations.