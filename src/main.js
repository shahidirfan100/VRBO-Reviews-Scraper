import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

const GRAPHQL_URL = 'https://www.expedia.com/graphql';
const DETAIL_PAGE_SIZE = 10;
const DEFAULT_RESULTS_WANTED = 20;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PUSH_BATCH_SIZE = 100;
const MAX_API_ATTEMPTS = 6;
const MAX_WARMUP_ATTEMPTS = 3;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:147.0) Gecko/20100101 Firefox/147.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
];

const DETAIL_QUERY = `
query GetProductReviews($productIdentifier: ProductIdentifierInput!, $context: ContextInput!) {
  productReviewDetails(productIdentifier: $productIdentifier, context: $context) {
    reviews {
      details {
        id
        disclaimer
        summary {
          primary
          secondary
          accessibilityLabel
        }
        review {
          title
          text
        }
        managementResponses {
          title
          text
        }
        tripSummary {
          __typename
          ... on EGDSPlainText {
            text
            accessibility
          }
          ... on EGDSGraphicText {
            text
            accessibility
          }
        }
        sentiments {
          label
        }
      }
      pagination {
        button {
          primary
          accessibility
        }
      }
    }
  }
}
`;

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanString(value) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}

function sanitizeUrlLikeString(value) {
    const raw = cleanString(value);
    if (!raw) return undefined;

    return raw
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/^["'(<\s]+/, '')
        .replace(/["'>)\s]+$/, '');
}

function parseMaybeUrl(value) {
    const cleaned = sanitizeUrlLikeString(value);
    if (!cleaned) return undefined;

    const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(cleaned)
        ? cleaned
        : `https://${cleaned.replace(/^\/+/, '')}`;

    try {
        return new URL(candidate);
    } catch {
        return undefined;
    }
}

function normalizePropertyIdCandidate(value) {
    const normalized = cleanString(String(value ?? ''));
    if (!normalized) return undefined;

    const digits = normalized.replace(/\D+/g, '');
    return digits.length >= 5 ? digits : undefined;
}

function extractNumericCandidates(text) {
    const normalized = cleanString(text);
    if (!normalized) return [];

    const matches = normalized.match(/\d{5,}/g) ?? [];
    return [...new Set(matches)];
}

function pickBestPropertyIdCandidate(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return undefined;

    const sorted = [...new Set(candidates)]
        .map((item) => normalizePropertyIdCandidate(item))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

    return sorted[0];
}

function safeDecode(value) {
    const raw = cleanString(value);
    if (!raw) return '';

    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function deepClean(value) {
    if (Array.isArray(value)) {
        const cleaned = value.map((item) => deepClean(item)).filter((item) => item !== undefined);
        return cleaned.length ? cleaned : undefined;
    }

    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(value)) {
            const cleaned = deepClean(val);
            if (cleaned !== undefined) out[key] = cleaned;
        }
        return Object.keys(out).length ? out : undefined;
    }

    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') return cleanString(value);
    return value;
}

function extractPropertyId(input) {
    // Respect direct user input first when propertyId is explicitly provided.
    const direct = normalizePropertyIdCandidate(input.propertyId);
    if (direct) return direct;

    const rawUrl = sanitizeUrlLikeString(input.url);
    if (!rawUrl) return undefined;

    const parsed = parseMaybeUrl(rawUrl);
    const highConfidence = [];

    const namedParamPattern = /(expediaPropertyId|selected|propertyId|hotelId|listingId)=([^&#]+)/gi;
    for (const match of rawUrl.matchAll(namedParamPattern)) {
        const candidate = normalizePropertyIdCandidate(safeDecode(match[2] ?? ''));
        if (candidate) highConfidence.push(candidate);
    }

    if (parsed) {
        const queryCandidates = ['expediaPropertyId', 'selected', 'propertyId', 'hotelId', 'listingId', 'id'];
        for (const key of queryCandidates) {
            const candidate = normalizePropertyIdCandidate(parsed.searchParams.get(key));
            if (candidate) highConfidence.push(candidate);
        }

        const expediaPathMatch = parsed.pathname.match(/\.h(\d+)\./i);
        if (expediaPathMatch?.[1]) highConfidence.push(expediaPathMatch[1]);

        const vrboPathMatch = parsed.pathname.match(/(?:^|\/)(\d{5,})(?:$|[/?#])/);
        if (vrboPathMatch?.[1]) highConfidence.push(vrboPathMatch[1]);
    }

    const bestHighConfidence = pickBestPropertyIdCandidate(highConfidence);
    if (bestHighConfidence) return bestHighConfidence;

    const looseCandidates = extractNumericCandidates(safeDecode(rawUrl));
    return pickBestPropertyIdCandidate(looseCandidates);
}

function hasTargetInput(input) {
    if (!input || typeof input !== 'object') return false;
    return Boolean(cleanString(input.url) || normalizePropertyIdCandidate(input.propertyId));
}

async function loadFallbackInput() {
    try {
        const fallbackPath = new URL('../INPUT.json', import.meta.url);
        const parsed = JSON.parse(await readFile(fallbackPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function buildContext(input) {
    return {
        siteId: 1,
        locale: cleanString(input.locale) ?? 'en_US',
        eapid: 0,
        tpid: 1,
        currency: cleanString(input.currency) ?? 'USD',
        device: { type: 'DESKTOP' },
        identity: {
            duaid: randomUUID(),
            authState: 'ANONYMOUS',
        },
        privacyTrackingState: 'CAN_TRACK',
    };
}

function buildHeaders(userAgent) {
    return {
        accept: '*/*',
        'content-type': 'application/json',
        origin: 'https://www.vrbo.com',
        referer: 'https://www.vrbo.com/',
        'accept-language': 'en-US,en;q=0.9',
        'x-parent-brand-id': 'expedia',
        'x-product-line': 'lodging',
        'x-shopping-product-line': 'lodging',
        'x-page-id': 'page.Hotels.Infosite.Information,Hotel',
        'x-hcom-origin-id': 'page.Hotels.Infosite.Information,Hotel',
        'client-info': 'shopping-pwa,3ebe5af271d6f9763c9b34fac1b1b1108a5ee1ff,us-east-1',
        'user-agent': userAgent,
    };
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function pickRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function createProxySessionId(prefix = 'vrbo') {
    // Apify proxy session IDs must match /^[\w._~]+$/ (hyphens are not allowed).
    const safePrefix = cleanString(prefix)?.replace(/[^\w._~]/g, '_') ?? 'vrbo';
    return `${safePrefix}_${randomUUID().replace(/-/g, '')}`;
}

function buildPropertyUrl(inputUrl, propertyId) {
    const parsedInputUrl = parseMaybeUrl(inputUrl)?.toString();
    if (parsedInputUrl) return parsedInputUrl;
    if (propertyId) return `https://www.vrbo.com/${propertyId}?expediaPropertyId=${propertyId}`;
    return 'https://www.vrbo.com/';
}

async function pushDataInBatches(items, batchSize = DEFAULT_PUSH_BATCH_SIZE) {
    const safeItems = Array.isArray(items) ? items : [];
    const safeBatchSize = toPositiveInt(batchSize, DEFAULT_PUSH_BATCH_SIZE);

    for (let offset = 0; offset < safeItems.length; offset += safeBatchSize) {
        const batch = safeItems.slice(offset, offset + safeBatchSize);
        await Actor.pushData(batch);
    }
}

function extractCookiesFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') return undefined;

    const rawSetCookie = headers['set-cookie'] ?? headers['Set-Cookie'];
    let entries = [];
    if (Array.isArray(rawSetCookie)) entries = rawSetCookie;
    else if (typeof rawSetCookie === 'string') entries = [rawSetCookie];

    const cookieParts = entries
        .map((line) => cleanString(line?.split(';')[0]))
        .filter(Boolean);

    return cookieParts.length ? cookieParts.join('; ') : undefined;
}

async function warmupSession({ url, userAgent, proxyConfiguration, proxySessionId }) {
    for (let attempt = 1; attempt <= MAX_WARMUP_ATTEMPTS; attempt++) {
        try {
            const proxyUrl = proxyConfiguration
                ? await proxyConfiguration.newUrl(proxySessionId)
                : undefined;

            const response = await gotScraping({
                url,
                method: 'GET',
                proxyUrl,
                throwHttpErrors: false,
                responseType: 'text',
                retry: { limit: 0 },
                timeout: { request: 45_000 },
                headers: {
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                    'upgrade-insecure-requests': '1',
                    'user-agent': userAgent,
                },
            });

            const cookies = extractCookiesFromHeaders(response.headers);

            return {
                statusCode: response.statusCode,
                html: typeof response.body === 'string' ? response.body : '',
                cookies,
            };
        } catch (error) {
            const backoffMs = Math.min(1200 * 2 ** (attempt - 1), 8000);
            log.warning(`Warmup attempt ${attempt}/${MAX_WARMUP_ATTEMPTS} failed: ${error.message}`);
            await sleep(backoffMs);
        }
    }

    return { statusCode: 0, html: '', cookies: undefined };
}

async function postGraphQL({ payload, headers, proxyConfiguration, attempt, proxySessionId, cookieHeader }) {
    const proxyUrl = proxyConfiguration
        ? await proxyConfiguration.newUrl(proxySessionId ?? createProxySessionId(`vrbo_reviews_${attempt}`))
        : undefined;

    const finalHeaders = {
        ...headers,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
    };

    const response = await gotScraping({
        url: GRAPHQL_URL,
        method: 'POST',
        headers: finalHeaders,
        body: JSON.stringify([payload]),
        proxyUrl,
        responseType: 'text',
        throwHttpErrors: false,
        timeout: { request: 45_000 },
        retry: { limit: 0 },
        https: { rejectUnauthorized: true },
    });

    let parsedBody;
    try {
        parsedBody = JSON.parse(response.body);
    } catch {
        parsedBody = undefined;
    }

    return {
        statusCode: response.statusCode,
        bodyText: response.body,
        json: parsedBody,
    };
}

function unwrapGraphQLResponse(responseJson) {
    return Array.isArray(responseJson) ? responseJson[0] : responseJson;
}

function buildDetailPayload({ propertyId, pageIndex, context, inputUrl }) {
    return {
        operationName: 'GetProductReviews',
        query: DETAIL_QUERY,
        variables: {
            productIdentifier: {
                id: propertyId,
                type: 'PROPERTY_ID',
                travelSearchCriteria: {
                    property: {
                        primary: buildPrimaryPropertyCriteria(inputUrl),
                        secondary: {
                            counts: [
                                { id: 'pageIndex', value: pageIndex },
                                { id: 'size', value: DETAIL_PAGE_SIZE },
                            ],
                            booleans: [],
                            selections: [
                                { id: 'sortBy', value: '' },
                                { id: 'searchTerm', value: '' },
                                { id: 'travelerType', value: '' },
                            ],
                            ranges: [],
                        },
                    },
                },
            },
            context,
        },
    };
}

function buildOverviewPayload({ propertyId, context, inputUrl }) {
    return {
        operationName: 'PWAReviewsOverviewComponentReviewsOverviewQuery',
        variables: {
            productIdentifier: {
                id: propertyId,
                type: 'PROPERTY_ID',
                travelSearchCriteria: {
                    property: {
                        primary: buildPrimaryPropertyCriteria(inputUrl),
                        secondary: {
                            counts: [],
                            booleans: [],
                            selections: [
                                { id: 'privacyTrackingState', value: 'CAN_TRACK' },
                                { id: 'selected', value: propertyId },
                                { id: 'sort', value: 'RECOMMENDED' },
                                { id: 'useRewards', value: 'SHOP_WITHOUT_POINTS' },
                            ],
                            ranges: [],
                        },
                    },
                },
            },
            context,
        },
        extensions: {
            persistedQuery: {
                version: 1,
                sha256Hash: '6f89d4ea396c952169bef5261dca1fecc4f7607e3c1f558cb34d17fac22c0c3d',
            },
        },
    };
}

function readTripSummary(tripSummary) {
    if (!tripSummary || typeof tripSummary !== 'object') return undefined;
    return cleanString(tripSummary.text) ?? cleanString(tripSummary.accessibility);
}

function buildStableReviewKey(review) {
    const hashParts = [
        cleanString(review?.property_id),
        cleanString(review?.review_id),
        cleanString(review?.author),
        cleanString(review?.title),
        cleanString(review?.review_text),
    ]
        .filter(Boolean)
        .map((item) => item.toLowerCase());

    return hashParts.join('|');
}

function extractInputTravelSignals(inputUrl) {
    const out = {};
    const url = cleanString(inputUrl);
    if (!url) return out;

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return out;
    }

    const regionIdRaw = cleanString(parsed.searchParams.get('regionId'));
    const regionId = Number.parseInt(String(regionIdRaw ?? ''), 10);
    if (Number.isFinite(regionId) && regionId > 0) out.regionId = String(regionId);

    const location = cleanString(parsed.searchParams.get('location'));
    if (location) out.location = location;

    const latLong = cleanString(parsed.searchParams.get('latLong'));
    if (latLong) {
        const [lat, lng] = latLong.split(',').map((value) => Number.parseFloat(value));
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            out.coordinates = { latitude: lat, longitude: lng };
        }
    }

    return out;
}

function buildPrimaryPropertyCriteria(inputUrl) {
    const signals = extractInputTravelSignals(inputUrl);
    const destination = deepClean({
        regionId: signals.regionId,
        coordinates: signals.coordinates,
    });

    if (!destination) {
        return {
            destination: {
                regionId: '1',
            },
            rooms: [{ adults: 2, children: [] }],
        };
    }

    return {
        destination,
        rooms: [{ adults: 2, children: [] }],
    };
}

function extractJsonLdBlocks(html) {
    const matches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    const parsed = [];

    for (const block of matches) {
        const contentMatch = block.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
        const text = cleanString(contentMatch?.[1]);
        if (!text) continue;

        try {
            parsed.push(JSON.parse(text));
        } catch {
            continue;
        }
    }

    return parsed;
}

function walkForReviews(node, sink) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) walkForReviews(item, sink);
        return;
    }

    const type = cleanString(node['@type']);
    if (type && type.toLowerCase() === 'review') sink.push(node);

    for (const value of Object.values(node)) {
        walkForReviews(value, sink);
    }
}

function parseHtmlJsonReviews(html, { propertyId, inputUrl }) {
    const jsonLd = extractJsonLdBlocks(html);
    const reviewNodes = [];

    for (const block of jsonLd) {
        walkForReviews(block, reviewNodes);
    }

    return reviewNodes
        .map((node, idx) => deepClean({
            property_id: propertyId,
            review_id: cleanString(node?.['@id']) ?? cleanString(node?.url),
            rating_label: cleanString(node?.reviewRating?.ratingValue),
            author: cleanString(node?.author?.name) ?? cleanString(node?.author),
            title: cleanString(node?.name),
            review_text: cleanString(node?.reviewBody) ?? cleanString(node?.description),
            disclaimer: cleanString(node?.publisher?.name),
            page_index: 0,
            position: idx + 1,
            source_type: 'jsonLdReview',
            source_url: inputUrl,
            input_url: inputUrl,
            scraped_at: new Date().toISOString(),
        }))
        .filter(Boolean);
}

function extractNextDataJson(html) {
    const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    const raw = cleanString(match?.[1]);
    if (!raw) return undefined;

    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

function looksLikeReviewObject(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;

    const hasText = cleanString(node.reviewBody)
        || cleanString(node.text)
        || cleanString(node.message)
        || cleanString(node.description);
    const hasMeta = cleanString(node.title)
        || cleanString(node.headline)
        || cleanString(node.name)
        || cleanString(node.author?.name)
        || cleanString(node.userName);

    return Boolean(hasText && hasMeta);
}

function collectReviewLikeObjects(node, sink) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) collectReviewLikeObjects(item, sink);
        return;
    }

    if (looksLikeReviewObject(node)) sink.push(node);

    for (const value of Object.values(node)) {
        collectReviewLikeObjects(value, sink);
    }
}

function parseNextDataReviews(html, { propertyId, inputUrl }) {
    const nextData = extractNextDataJson(html);
    if (!nextData) return [];

    const reviewNodes = [];
    collectReviewLikeObjects(nextData, reviewNodes);

    return reviewNodes
        .map((node, idx) => deepClean({
            property_id: propertyId,
            review_id: cleanString(node.id) ?? cleanString(node.reviewId) ?? cleanString(node.uuid),
            rating_label: cleanString(node.rating)
                ?? cleanString(node.ratingValue)
                ?? cleanString(node.reviewRating?.ratingValue),
            author: cleanString(node.author?.name) ?? cleanString(node.userName) ?? cleanString(node.author),
            title: cleanString(node.title) ?? cleanString(node.headline) ?? cleanString(node.name),
            review_text: cleanString(node.reviewBody)
                ?? cleanString(node.text)
                ?? cleanString(node.message)
                ?? cleanString(node.description),
            page_index: 0,
            position: idx + 1,
            source_type: 'nextDataReview',
            source_url: inputUrl,
            input_url: inputUrl,
            scraped_at: new Date().toISOString(),
        }))
        .filter(Boolean);
}

function parseDetailReviews(root, { propertyId, inputUrl, pageIndex }) {
    const details = root?.data?.productReviewDetails?.reviews?.details;
    if (!Array.isArray(details)) return [];

    return details
        .map((review, idx) => deepClean({
            property_id: propertyId,
            review_id: review?.id,
            rating_label: review?.summary?.primary,
            author: review?.summary?.secondary,
            summary_accessibility: review?.summary?.accessibilityLabel,
            title: review?.review?.title,
            review_text: review?.review?.text,
            disclaimer: review?.disclaimer,
            trip_summary: readTripSummary(review?.tripSummary),
            sentiments: Array.isArray(review?.sentiments)
                ? review.sentiments.map((item) => cleanString(item?.label)).filter(Boolean)
                : undefined,
            management_response: Array.isArray(review?.managementResponses)
                ? review.managementResponses
                    .map((item) => [cleanString(item?.title), cleanString(item?.text)].filter(Boolean).join(': '))
                    .filter(Boolean)
                    .join(' | ')
                : undefined,
            page_index: pageIndex,
            position: idx + 1,
            source_type: 'productReviewDetails',
            source_url: GRAPHQL_URL,
            input_url: inputUrl,
            scraped_at: new Date().toISOString(),
        }))
        .filter(Boolean);
}

function parseOverviewFallback(root, { propertyId, inputUrl }) {
    const items = root?.data?.reviewsOverview?.carousel?.items;
    if (!Array.isArray(items)) return [];

    return items
        .map((item, idx) => {
            const message = typeof item?.message === 'string' ? item.message : item?.message?.text;
            return deepClean({
                property_id: propertyId,
                review_id: item?.id,
                rating_label: item?.heading?.text,
                author: item?.footer?.primary?.text,
                title: item?.heading?.text,
                review_text: message,
                disclaimer: item?.disclaimer?.text,
                page_index: 0,
                position: idx + 1,
                source_type: 'reviewsOverviewCarousel',
                source_url: GRAPHQL_URL,
                input_url: inputUrl,
                scraped_at: new Date().toISOString(),
            });
        })
        .filter(Boolean);
}

async function requestWithRetries({ payload, headers, proxyConfiguration, operationLabel, proxySessionId, cookieHeader }) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
        try {
            const response = await postGraphQL({
                payload,
                headers,
                proxyConfiguration,
                attempt,
                proxySessionId,
                cookieHeader,
            });

            if (response.statusCode === 200 && response.json) {
                const root = unwrapGraphQLResponse(response.json);
                if (!root?.errors?.length) return root;
                lastError = new Error(`${operationLabel} returned GraphQL errors: ${JSON.stringify(root.errors)}`);
            } else {
                const snippet = cleanString(response.bodyText)?.slice(0, 500);
                lastError = new Error(`${operationLabel} HTTP ${response.statusCode}${snippet ? ` body=${snippet}` : ''}`);
            }
        } catch (error) {
            lastError = error;
        }

        const backoffMs = Math.min(1500 * 2 ** (attempt - 1), 12_000);
        log.warning(`${operationLabel} attempt ${attempt}/${MAX_API_ATTEMPTS} failed, retrying in ${backoffMs} ms`);
        await sleep(backoffMs);
    }

    throw lastError ?? new Error(`${operationLabel} failed for unknown reason`);
}

await Actor.main(async () => {
    const actorInput = await Actor.getInput();
    let input = actorInput && typeof actorInput === 'object' ? actorInput : {};

    if (!hasTargetInput(input)) {
        const fallbackInput = await loadFallbackInput();
        if (hasTargetInput(fallbackInput)) {
            input = {
                ...fallbackInput,
                ...input,
            };
            log.info('No valid property target in actor input, using fallback target from INPUT.json');
        }
    }

    const inputUrl = cleanString(input.url);
    const propertyId = extractPropertyId(input);
    const propertyUrl = buildPropertyUrl(inputUrl, propertyId);
    const resultsWanted = toPositiveInt(input.results_wanted, DEFAULT_RESULTS_WANTED);
    const maxPages = toPositiveInt(input.max_pages, DEFAULT_MAX_PAGES);

    if (!propertyId) {
        throw new Error('Missing property id. Provide "propertyId" directly or a VRBO/Expedia URL containing property id metadata.');
    }

    const context = buildContext(input);
    const userAgent = pickRandomUserAgent();
    const headers = buildHeaders(userAgent);
    headers.referer = propertyUrl;

    const defaultProxyConfiguration = Actor.isAtHome()
        ? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
        : { useApifyProxy: false };
    const proxyConfiguration = await Actor.createProxyConfiguration(
        input.proxyConfiguration ?? defaultProxyConfiguration,
    );

    log.info(`Starting VRBO reviews API scrape for property ${propertyId}`);
    log.info(`Target: up to ${resultsWanted} reviews across ${maxPages} pages`);

    const collected = [];
    const seenReviewKeys = new Set();
    const proxySessionId = createProxySessionId('vrbo');

    const warmupResult = await warmupSession({
        url: propertyUrl,
        userAgent,
        proxyConfiguration,
        proxySessionId,
    });

    const cookieHeader = warmupResult.cookies;

    for (let pageIndex = 0; pageIndex < maxPages && collected.length < resultsWanted; pageIndex++) {
        const payload = buildDetailPayload({
            propertyId,
            pageIndex,
            context,
            inputUrl: propertyUrl,
        });
        let root;

        try {
            root = await requestWithRetries({
                payload,
                headers,
                proxyConfiguration,
                operationLabel: `detail-page-${pageIndex}`,
                proxySessionId,
                cookieHeader,
            });
        } catch (error) {
            log.warning(`Detail query failed for page ${pageIndex}: ${error.message}`);
            if (pageIndex === 0) break;
            continue;
        }

        const pageReviews = parseDetailReviews(root, {
            propertyId,
            inputUrl: propertyUrl,
            pageIndex,
        });

        if (!pageReviews.length) {
            log.info(`No detail reviews returned on page ${pageIndex}, stopping detail pagination`);
            break;
        }

        for (const review of pageReviews) {
            if (collected.length >= resultsWanted) break;
            const key = buildStableReviewKey(review);
            if (!key || seenReviewKeys.has(key)) continue;
            seenReviewKeys.add(key);
            collected.push(review);
        }

        if (pageReviews.length < DETAIL_PAGE_SIZE) {
            log.info(`Received only ${pageReviews.length} reviews on page ${pageIndex}, assuming final page`);
            break;
        }
    }

    if (!collected.length) {
        log.warning('Detail query returned no reviews. Trying reviews-overview fallback query.');

        try {
            const fallbackRoot = await requestWithRetries({
                payload: buildOverviewPayload({
                    propertyId,
                    context,
                    inputUrl: propertyUrl,
                }),
                headers,
                proxyConfiguration,
                operationLabel: 'overview-fallback',
                proxySessionId,
                cookieHeader,
            });

            const fallbackItems = parseOverviewFallback(fallbackRoot, {
                propertyId,
                inputUrl: propertyUrl,
            });

            for (const item of fallbackItems) {
                if (collected.length >= resultsWanted) break;
                const key = buildStableReviewKey(item);
                if (!key || seenReviewKeys.has(key)) continue;
                seenReviewKeys.add(key);
                collected.push(item);
            }
        } catch (error) {
            log.warning(`Overview fallback failed: ${error.message}`);
        }
    }

    if (!collected.length && warmupResult.html) {
        log.warning('GraphQL review endpoints returned no records. Trying JSON hydration fallback from property page.');
        const htmlItems = parseHtmlJsonReviews(warmupResult.html, {
            propertyId,
            inputUrl: propertyUrl,
        });

        for (const item of htmlItems) {
            if (collected.length >= resultsWanted) break;
            const key = buildStableReviewKey(item);
            if (!key || seenReviewKeys.has(key)) continue;
            seenReviewKeys.add(key);
            collected.push(item);
        }

        if (collected.length < resultsWanted) {
            const nextDataItems = parseNextDataReviews(warmupResult.html, {
                propertyId,
                inputUrl: propertyUrl,
            });

            for (const item of nextDataItems) {
                if (collected.length >= resultsWanted) break;
                const key = buildStableReviewKey(item);
                if (!key || seenReviewKeys.has(key)) continue;
                seenReviewKeys.add(key);
                collected.push(item);
            }
        }
    }

    if (!collected.length) {
        throw new Error('No reviews were collected. This usually means the target blocked the request. Try Apify Proxy with RESIDENTIAL group.');
    }

    const outputItems = collected.slice(0, resultsWanted);
    await pushDataInBatches(outputItems);
    log.info(`Finished. Saved ${outputItems.length} review records.`);
});
