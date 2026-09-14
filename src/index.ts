interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * Hong Kong equities MCP. Keyless.
 *
 * Built from logged demand: 恒生指数 / 恒生中国企业指数 / 恒生科技指数 were among the
 * most-repeated unmet queries, and the only thing serving ^HSI was one symbol
 * buried inside market-recap's cross-region basket — which neither the English
 * nor the Chinese phrasing could route to. This is the branded entry point.
 *
 * Sources (both keyless, both verified reachable from CF Workers):
 *  - Sina hq.sinajs.cn — index levels and HK equity quotes. GBK-encoded
 *    (Chinese names), decoded from raw bytes via TextDecoder.
 *  - Yahoo Finance search — company name → HK ticker. Used ONLY as a resolver.
 *
 * Why Yahoo for resolution and not Sina: Sina's own HK suggest endpoint is
 * effectively a warrant index. Searching "tencent" returns TENCENT N4104,
 * TENCENT N6006, TENCENT N3606-R … and never 00700 at all. Resolving through
 * it would answer confidently from the wrong ID space — derivative warrants
 * dressed as the underlying. Yahoo returns 0700.HK as the top hit and exposes
 * exchange/quoteType, so equities can be isolated explicitly.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Hong Kong equities');
}

const SINA = 'https://hq.sinajs.cn';
const YF_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const SINA_SUGGEST = 'https://suggest3.sinajs.cn';
const SINA_HEADERS = { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 (pipeworx.io)' };
const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp/1.0; +https://pipeworx.io)';

// The Hang Seng family, Sina symbol → names. VHSI is the volatility index —
// included because "is the market panicking" is a different question from
// "where did it close", and VHSI is the only one of these that answers it.
const HK_INDICES: Array<{ sym: string; name: string; cn: string; note: string }> = [
  { sym: 'HSI', name: 'Hang Seng Index', cn: '恒生指数', note: 'The headline HK benchmark.' },
  { sym: 'HSCEI', name: 'Hang Seng China Enterprises Index', cn: '恒生中国企业指数', note: 'Mainland companies listed in HK (H-shares).' },
  { sym: 'HSTECH', name: 'Hang Seng TECH Index', cn: '恒生科技指数', note: "HK's largest tech names — the 'HK Nasdaq'." },
  { sym: 'HSCCI', name: 'Hang Seng China-Affiliated Corporations Index', cn: '恒生香港中资企业指数', note: 'Red chips — mainland-controlled but HK-incorporated.' },
  { sym: 'VHSI', name: 'HSI Volatility Index', cn: '恒指波幅指数', note: 'Implied 30-day volatility on the HSI; higher = more fear priced in.' },
];

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function round(n: number | null, dp = 3): number | null {
  if (n == null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Normalize anything an agent might pass into Sina's 5-digit HK code.
 * Accepts 700, 00700, 0700.HK, HK:700.
 */
function hkCode(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/^HK[:\-]?/, '').replace(/\.HK$/, '');
  const digits = s.replace(/\D/g, '');
  if (!digits || digits.length > 5) return null;
  return digits.padStart(5, '0');
}

/** Parse Sina `var hq_str_X="a,b,c";` lines into their comma fields. */
function parseSinaLines(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_([A-Za-z0-9_]+)="([^"]*)"/);
    if (m && m[2]) out.set(m[1], m[2].split(','));
  }
  return out;
}

async function fetchSina(symbols: string[]): Promise<Map<string, string[]>> {
  const res = await pwFetch(`${SINA}/list=${symbols.join(',')}`, { headers: SINA_HEADERS });
  if (!res.ok) throw await httpError(res, 'Sina');
  // GBK, not UTF-8 — Chinese names arrive as mojibake if decoded via text().
  return parseSinaLines(new TextDecoder('gbk').decode(await res.arrayBuffer()));
}

// Sina's rt_hk field layout (verified against HSI and 00700, 2026-07-29):
//   0 name_en  1 name_cn  2 open  3 prev_close  4 high  5 low  6 last
//   7 change   8 change_pct  9 bid  10 ask  11 turnover_hkd  12 volume_shares
//   13 pe      15 52w_high   16 52w_low  17 date  18 time
const F = {
  nameEn: 0, nameCn: 1, open: 2, prevClose: 3, high: 4, low: 5, last: 6,
  change: 7, changePct: 8, turnover: 11, volume: 12, pe: 13,
  high52: 15, low52: 16, date: 17, time: 18,
};

const tools: McpToolExport['tools'] = [
  {
    name: 'hk_market_snapshot',
    description:
      "Hong Kong stock market snapshot — closing levels and daily change for the whole Hang Seng index family: the Hang Seng Index (恒生指数, HSI), Hang Seng China Enterprises Index (恒生中国企业指数, HSCEI, the H-share benchmark), Hang Seng TECH Index (恒生科技指数, HSTECH), Hang Seng China-Affiliated Corporations Index (恒生香港中资企业指数, HSCCI, red chips), and the HSI Volatility Index (恒指波幅指数, VHSI). Answers 'Hang Seng index today', 'how did Hong Kong stocks close', '恒生指数最新收盘点位和涨跌幅', '恒生科技指数', 'HSCEI level', 'Hong Kong market close'. Each index returns level, change, change %, open, day high/low and 52-week high/low. Source: Sina (keyless).",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'hk_quote',
    description:
      'Real-time quote(s) for Hong Kong-listed stocks by HKEX code. Answers \'Tencent stock price\', \'腾讯股价\', \'00700 quote\', \'HSBC Hong Kong share price\'. Accepts one code or a comma-separated list, in any common form (700, 00700, 0700.HK). Returns English and Chinese name, price, change and change %, open, previous close, day high/low, volume, turnover in HKD, P/E, and the 52-week range. If you have a company NAME rather than a code, call hk_resolve_symbol first. Example: hk_quote({ codes: "00700,00005" }) for Tencent and HSBC. Source: Sina (keyless).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        codes: { type: 'string', description: 'One HKEX code or a comma-separated list, e.g. "00700" or "700,5,9988". Accepts 0700.HK form too. Max 30.' },
      },
      required: ['codes'],
    },
  },
  {
    name: 'hk_resolve_symbol',
    description:
      "Find the HKEX stock code for a company by name — the lookup step before hk_quote. Answers 'what is Tencent's Hong Kong ticker', 'Xiaomi HK code', 'Alibaba Hong Kong listing'. Returns ONLY Hong Kong-listed equities: derivative warrants, CBBCs and non-HK listings (ADRs, US/Frankfurt lines) are excluded, and each match states the code it resolved to so you can confirm it is the company you meant before quoting it. Source: Yahoo Finance search (keyless).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Company name, in English or Chinese, e.g. "Tencent", "小米", "HSBC".' },
        limit: { type: 'number', description: 'Max matches to return, 1–10 (default 5).' },
      },
      required: ['name'],
    },
  },
];

async function marketSnapshot() {
  const fields = await fetchSina(HK_INDICES.map((i) => `rt_hk${i.sym}`));
  let asOf: string | null = null;

  const indices = HK_INDICES.map((idx) => {
    const f = fields.get(`rt_hk${idx.sym}`);
    if (!f || f.length < 17) return { index: idx.name, cn_name: idx.cn, symbol: idx.sym, found: false };
    if (!asOf && f[F.date] && f[F.time]) asOf = `${f[F.date].replace(/\//g, '-')} ${f[F.time]}`;
    return {
      index: idx.name,
      cn_name: idx.cn,
      symbol: idx.sym,
      level: round(num(f[F.last]), 2),
      change: round(num(f[F.change]), 2),
      change_pct: round(num(f[F.changePct]), 2),
      open: round(num(f[F.open]), 2),
      prev_close: round(num(f[F.prevClose]), 2),
      day_high: round(num(f[F.high]), 2),
      day_low: round(num(f[F.low]), 2),
      week52_high: round(num(f[F.high52]), 2),
      week52_low: round(num(f[F.low52]), 2),
      what_it_tracks: idx.note,
    };
  });

  return {
    market: 'Hong Kong (HKEX)',
    as_of: asOf,
    timezone: 'Asia/Hong_Kong',
    indices,
    // Sina populates the turnover/volume slots differently for index rows than
    // for equities, and the index values do not reconcile against known HKEX
    // market turnover. Rather than publish a number we cannot account for,
    // omit it and say so — a stated gap beats a plausible wrong figure.
    note: 'Levels are index points. Turnover/volume are deliberately omitted for indices: Sina reuses those fields inconsistently on index rows and the values do not reconcile against known HKEX market turnover. Per-stock turnover IS reliable — use hk_quote. VHSI is a volatility measure, not a price index, so its level is not comparable to the others.',
    source: 'Sina Finance (hq.sinajs.cn), keyless',
  };
}

async function quote(args: Record<string, unknown>) {
  const raw = String(args.codes ?? args.code ?? args.symbols ?? args.symbol ?? '').trim();
  if (!raw) throw new Error('codes is required, e.g. hk_quote({ codes: "00700" }) or "00700,00005".');

  const requested = raw.split(/[,\s;]+/).filter(Boolean).slice(0, 30);
  const bad: string[] = [];
  const codes: string[] = [];
  for (const r of requested) {
    const c = hkCode(r);
    if (c) codes.push(c);
    else bad.push(r);
  }
  if (codes.length === 0) {
    throw new Error(`No valid HKEX codes in "${raw}". Codes are 1–5 digits (700, 00700, 0700.HK). For a company name, call hk_resolve_symbol first.`);
  }

  const fields = await fetchSina(codes.map((c) => `rt_hk${c}`));
  const quotes = codes.map((code) => {
    const f = fields.get(`rt_hk${code}`);
    // Sina returns an empty payload for a code that doesn't exist rather than
    // an error, so an unknown code must be reported as such, not as a blank quote.
    if (!f || f.length < 17 || !f[F.nameEn]) {
      return { code, found: false, message: `No HKEX listing found for ${code}.` };
    }
    return {
      code,
      name: f[F.nameEn] || null,
      name_cn: f[F.nameCn] || null,
      price: num(f[F.last]),
      prev_close: num(f[F.prevClose]),
      change: round(num(f[F.change])),
      change_pct: round(num(f[F.changePct]), 2),
      open: num(f[F.open]),
      day_high: num(f[F.high]),
      day_low: num(f[F.low]),
      volume_shares: num(f[F.volume]),
      turnover_hkd: round(num(f[F.turnover]), 2),
      pe: round(num(f[F.pe]), 2),
      week52_high: num(f[F.high52]),
      week52_low: num(f[F.low52]),
      as_of: f[F.date] && f[F.time] ? `${f[F.date].replace(/\//g, '-')} ${f[F.time]}` : null,
    };
  });

  return {
    count: quotes.length,
    currency: 'HKD',
    timezone: 'Asia/Hong_Kong',
    ...(bad.length ? { ignored_inputs: bad, ignored_reason: 'Not parseable as HKEX codes (1–5 digits). Use hk_resolve_symbol for company names.' } : {}),
    quotes,
    source: 'Sina Finance (hq.sinajs.cn), keyless',
  };
}

interface YfQuote { symbol?: string; exchange?: string; quoteType?: string; shortname?: string; longname?: string }
interface Match { code: string | null; name: string | null; yahoo_symbol?: string }

/**
 * HKEX numbering: equities and GEM live below 10000. Derivative warrants and
 * CBBCs occupy 10000–69999, and 80000+ are the RMB counters of dual-counter
 * stocks (腾讯控股-R = 80700). One threshold therefore excludes both classes of
 * near-miss at once — and both ARE near-misses: a warrant on Tencent and
 * Tencent's RMB counter both look like "Tencent" to a name search, and neither
 * is the HKD-traded share that "Tencent's HK code" means.
 */
function isHkEquityCode(code: string | null): boolean {
  if (!code) return false;
  const n = Number(code);
  return Number.isFinite(n) && n > 0 && n < 10000;
}

/** Chinese/CJK path — Sina's suggest, which ranks the real equity first. */
async function resolveViaSina(name: string, want: number): Promise<Match[]> {
  const url = `${SINA_SUGGEST}/suggest/type=31&key=${encodeURIComponent(name)}`;
  const res = await pwFetch(url, { headers: SINA_HEADERS });
  if (!res.ok) throw await httpError(res, 'Sina suggest');
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const m = text.match(/suggestvalue="([^"]*)"/);
  if (!m || !m[1]) return [];

  const out: Match[] = [];
  for (const row of m[1].split(';')) {
    const f = row.split(',');
    // f[1] is the asset type ('31' = Hong Kong), f[2] the code, f[0] the name.
    if (f.length < 3 || f[1] !== '31') continue;
    const code = f[2]?.trim();
    if (!isHkEquityCode(code)) continue;
    if (out.some((o) => o.code === code)) continue;
    out.push({ code, name: f[0] || null });
    if (out.length >= want) break;
  }
  return out;
}

/** Latin-script path — Yahoo, whose exchange/quoteType fields isolate equities. */
async function resolveViaYahoo(name: string, want: number): Promise<{ matches: Match[]; excluded: string[] }> {
  const url = `${YF_SEARCH}?q=${encodeURIComponent(name)}&quotesCount=25&newsCount=0`;
  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw await httpError(res, 'Yahoo search');
  const body = (await res.json()) as { quotes?: YfQuote[] };
  const all = body.quotes ?? [];

  // HKG + EQUITY is the whole point: it separates the company from its
  // warrants, its ADR, and its Frankfurt secondary line.
  const matches = all
    .filter((q) => q.exchange === 'HKG' && q.quoteType === 'EQUITY' && q.symbol)
    .filter((q) => isHkEquityCode(hkCode(q.symbol as string)))
    .slice(0, want)
    .map((q) => ({ code: hkCode(q.symbol as string), name: q.shortname ?? q.longname ?? null, yahoo_symbol: q.symbol }));

  const excluded = all.filter((q) => q.symbol && q.exchange !== 'HKG').slice(0, 5)
    .map((q) => `${q.symbol} (${q.exchange ?? '?'}, ${q.quoteType ?? '?'})`);
  return { matches, excluded };
}

async function resolveSymbol(args: Record<string, unknown>) {
  const name = String(args.name ?? args.query ?? args.q ?? '').trim();
  if (!name) throw new Error('name is required, e.g. hk_resolve_symbol({ name: "Tencent" }).');
  const want = Math.min(Math.max(Number(args.limit ?? 5), 1), 10);

  // Two upstreams because neither covers both scripts. Yahoo rejects any
  // non-ASCII query outright with HTTP 400 — so it cannot answer 腾讯 or 小米 at
  // all. Sina handles Chinese and ranks the real equity first, but on Latin
  // input its HK suggest degrades into a warrant index ("tencent" returns
  // TENCENT N4104, N6006, N3606-R … and never 00700). Each source is used only
  // on the script it actually handles.
  const isCjk = [...name].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
  let matches: Match[] = [];
  let excluded: string[] = [];
  let source: string;

  if (isCjk) {
    matches = await resolveViaSina(name, want);
    source = 'Sina Finance suggest (keyless)';
    // Latin fallback is pointless here (Yahoo 400s on CJK), so a CJK miss is final.
  } else {
    const y = await resolveViaYahoo(name, want);
    matches = y.matches;
    excluded = y.excluded;
    source = 'Yahoo Finance search (keyless)';
    // A Latin name can still be a HK company Yahoo indexes oddly; Sina's
    // Latin path is warrant-polluted but the equity filter makes it safe to try.
    if (matches.length === 0) {
      const fallback = await resolveViaSina(name, want).catch(() => [] as Match[]);
      if (fallback.length > 0) {
        matches = fallback;
        source = 'Sina Finance suggest (keyless, fallback after no Yahoo HK match)';
      }
    }
  }

  if (matches.length === 0) {
    return {
      query: name,
      found: false,
      // Naming what WAS found separates "no such company" from "this company
      // exists but is not listed in Hong Kong" — materially different answers.
      message: `No Hong Kong-listed equity matched "${name}".${excluded.length ? ` Non-HK listings exist and were excluded: ${excluded.join(', ')}.` : ''}`,
      matches: [],
      source,
    };
  }

  return {
    query: name,
    count: matches.length,
    matches,
    next_step: `Pass code(s) to hk_quote, e.g. hk_quote({ codes: "${matches[0].code}" }).`,
    note: 'Hong Kong-listed equities only (HKEX codes below 10000). Excluded: derivative warrants and CBBCs (10000–69999), the RMB counters of dual-counter stocks (80000+, e.g. 80700 is Tencent\'s RMB line, not its HKD share), ADRs and other non-HK listings. Confirm the returned name is the company you meant before relying on the quote.',
    source,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'hk_market_snapshot':
      return marketSnapshot();
    case 'hk_quote':
      return quote(args);
    case 'hk_resolve_symbol':
      return resolveSymbol(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
