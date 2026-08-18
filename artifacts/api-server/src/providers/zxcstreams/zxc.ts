/**
 * zxcstream.xyz backend client.
 * Reverse-engineered from cdn.zxcstream.xyz player (see chunk 11ro2bdg06qt5.js).
 *
 * Flow:
 *   1. Look up TMDB id + title/year/date/imdb from Cinemeta using the IMDb id.
 *   2. Generate a frontend token = sha512(`${ts}:${SALT}:${tmdbId}`).hex.slice(0,64).
 *   3. POST /backend/token with { rgrwsdsdfgwrwrwwr, xfgdfgdsffgrwgrwyjhkjt, rdghhdghhfssft }
 *      → { ZDDVHJFGHYRHG, rdghhdghhfssft }.
 *   4. GET /backend_/servers/{icarus|berkas|orion}?... with all the obfuscated fields.
 *
 * Domain auto-discovery:
 *   zxcstream changes their backend subdomain frequently. The two stable portal
 *   domains — zxcstream.xyz and zxcprime.xyz — always redirect to the current
 *   active instance via HTTP redirects. Discovery races both portals and takes
 *   whichever responds first. If both fail, known subdomains are probed in parallel.
 *   The resolved base is cached in memory for BASE_TTL ms.
 */

import { createHash } from "node:crypto";

// Both stable portals always redirect to the current live backend.
// We race them — whichever responds first wins.
const PORTALS = ["https://zxcstream.xyz", "https://zxcprime.xyz"] as const;
const INITIAL_BASE = "https://r1.zxcstream.xyz";
const SALT = "3435443433";
const SERVERS = ["icarus", "berkas", "orion", "athena"] as const;
const BASE_TTL = 10 * 60 * 1000; // 10 min
// Fallback subdomains to probe if both portal redirect methods fail
const PROBE_SUBDOMAINS = ["r1", "r2", "r3", "r4", "r5", "r6", "v4", "cdn", "api", "stream"];

const F = {
  id: "rgrwsdsdfgwrwrwwr",
  fToken: "xfgdfgdsffgrwgrwyjhkjt",
  ts: "rdghhdghhfssft",
  token: "ZDDVHJFGHYRHG",
  title: "TUKTHFSSFGDGHJS",
  year: "53653TRFG647GF",
  season: "adkljfhdahfladhfjahfjlahfhfljkadfdf",
  episode: "546745ygy46ytfgty",
  imdbId: "564745ygtuy5yi75yuy",
};

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

export interface StreamLink {
  server: string;
  type: "mp4" | "hls";
  resolution: number | string;
  size?: string;
  url: string;
  requestHeaders: Record<string, string>;
}

export interface Meta {
  tmdbId: string;
  title: string;
  year: string;
  releaseDate: string;
  imdbId: string;
}

interface CinemetaMeta {
  name?: string;
  moviedb_id?: number;
  imdb_id?: string;
  releaseInfo?: string;
  released?: string;
  year?: string;
}

// ── Domain auto-discovery ────────────────────────────────────────────────────

let _base = INITIAL_BASE;
let _baseValidatedAt = 0;
// Shared in-flight discovery promise: all concurrent server fetches wait on the
// SAME discovery run instead of each firing their own storm of probe requests
// (which got the IP rate-limited and returned zero streams).
let _discovery: Promise<string> | null = null;

/**
 * Verify that a candidate base URL actually serves the token endpoint.
 *
 * IMPORTANT: the backend rejects token requests that arrive without a player
 * Referer (403 {"error":"Forbiden"}), so the probe must mimic a real player
 * request exactly — otherwise every healthy host looks dead.
 */
async function verifyBase(base: string): Promise<string> {
  const rt = Date.now();
  const probeId = "550";
  const xt = createHash("sha512").update(`${rt}:${SALT}:${probeId}`).digest("hex").slice(0, 64);
  const r = await fetch(`${base}/backend/token`, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      Origin: base,
      Referer: `${base}/player/movie/${probeId}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ [F.id]: probeId, [F.fToken]: xt, [F.ts]: rt }),
    signal: AbortSignal.timeout(8000),
  });
  if (r.ok) {
    const d = (await r.json()) as Record<string, unknown>;
    if (d[F.token]) return base;
    throw new Error("verify failed: no token in response");
  }
  throw new Error(`verify failed: ${r.status}`);
}

/**
 * Follow a portal redirect and return the origin it lands on (unverified).
 * The portal usually lands on the player front-end (e.g. player.zxcstream.xyz),
 * which does NOT serve the API, so the result is only a candidate.
 */
async function portalCandidates(portal: string): Promise<string[]> {
  const r = await fetch(portal, {
    headers: { "User-Agent": COMMON_HEADERS["User-Agent"] },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const origin = new URL(r.url).origin;
  const host = new URL(origin).hostname;
  const out = [origin];
  // player.<domain> serves the UI; the API lives on the r* siblings of the
  // same apex domain — derive them so a moved domain is still discovered.
  const apex = host.split(".").slice(-2).join(".");
  for (const sub of PROBE_SUBDOMAINS) out.push(`https://${sub}.${apex}`);
  return out;
}

/**
 * Discover the current live base URL.
 * Builds an ordered candidate list (last known good → portal redirects and
 * their sibling API subdomains → hard-coded probes) and returns the first
 * candidate that actually answers the token endpoint.
 */
async function discoverBase(): Promise<string> {
  const candidates: string[] = [_base, INITIAL_BASE];

  const portalResults = await Promise.allSettled(PORTALS.map((p) => portalCandidates(p)));
  for (const r of portalResults) {
    if (r.status === "fulfilled") candidates.push(...r.value);
  }
  for (const sub of PROBE_SUBDOMAINS) candidates.push(`https://${sub}.zxcstream.xyz`);

  const seen = new Set<string>();
  const unique = candidates.filter((c) => !seen.has(c) && seen.add(c));

  // Verify in small batches so we never flood the origin with requests.
  for (let i = 0; i < unique.length; i += 4) {
    const batch = unique.slice(i, i + 4);
    const settled = await Promise.allSettled(batch.map((c) => verifyBase(c)));
    for (const r of settled) {
      if (r.status === "fulfilled") {
        console.log(`[zxc] discovered base: ${r.value}`);
        return r.value;
      }
    }
  }

  console.warn("[zxc] all discovery methods failed, keeping last known base:", _base);
  return _base;
}

/**
 * Return the current base URL, re-discovering if the TTL has expired.
 * Concurrent callers share one discovery run.
 */
async function getBase(): Promise<string> {
  if (Date.now() - _baseValidatedAt <= BASE_TTL) return _base;
  if (!_discovery) {
    _discovery = discoverBase()
      .then((b) => {
        _base = b;
        _baseValidatedAt = Date.now();
        return b;
      })
      .finally(() => {
        _discovery = null;
      });
  }
  return _discovery;
}

/**
 * Mark the current base as stale so the next call to getBase() re-discovers.
 */
function invalidateBase(): void {
  _baseValidatedAt = 0;
}

// ── Cinemeta ─────────────────────────────────────────────────────────────────

/** Look up TMDB id + title/year/date from Cinemeta by IMDb id. */
export async function getMetaFromCinemeta(
  type: "movie" | "series",
  imdbId: string,
): Promise<Meta | null> {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const res = await fetch(url, { headers: { "User-Agent": COMMON_HEADERS["User-Agent"] } });
  if (!res.ok) return null;
  const data = (await res.json()) as { meta?: CinemetaMeta };
  const m = data.meta;
  if (!m?.moviedb_id) return null;

  const releaseDate =
    (m.released && m.released.slice(0, 10)) ||
    (m.releaseInfo && /^\d{4}/.test(m.releaseInfo) ? `${m.releaseInfo.slice(0, 4)}-01-01` : "");
  const year =
    (m.releaseInfo && m.releaseInfo.slice(0, 4)) || (releaseDate && releaseDate.slice(0, 4)) || "";

  return {
    tmdbId: String(m.moviedb_id),
    title: m.name || "",
    year,
    releaseDate,
    imdbId,
  };
}

// ── Token + stream fetching ───────────────────────────────────────────────────

function generateFrontendToken(tmdbId: string) {
  const rt = Date.now();
  const xt = createHash("sha512").update(`${rt}:${SALT}:${tmdbId}`).digest("hex").slice(0, 64);
  return { xt, rt };
}

async function requestServerToken(base: string, tmdbId: string, referer: string) {
  const { xt, rt } = generateFrontendToken(tmdbId);
  const body = JSON.stringify({
    [F.id]: tmdbId,
    [F.fToken]: xt,
    [F.ts]: rt,
  });
  const res = await fetch(`${base}/backend/token`, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      Origin: base,
      "Content-Type": "application/json",
      Referer: referer,
    },
    body,
  });
  if (!res.ok) throw new Error(`token failed ${res.status}`);
  const data = (await res.json()) as { ZDDVHJFGHYRHG: string; rdghhdghhfssft: number };
  return { serverToken: data.ZDDVHJFGHYRHG, serverTs: data.rdghhdghhfssft, xt };
}

async function fetchServer(
  server: string,
  meta: Meta,
  type: "movie" | "tv",
  season: number | null,
  episode: number | null,
): Promise<StreamLink[]> {
  let base = await getBase();

  const buildReferer = (b: string) =>
    `${b}/player/${type}/${meta.tmdbId}${season != null ? `/${season}/${episode}` : ""}`;

  let referer = buildReferer(base);
  let tokenData: Awaited<ReturnType<typeof requestServerToken>>;

  try {
    tokenData = await requestServerToken(base, meta.tmdbId, referer);
  } catch (err) {
    // Token request failed — domain may have moved; re-discover and retry once
    console.warn(`[zxc] token request failed on ${base}, re-discovering...`, err);
    invalidateBase();
    base = await getBase();
    referer = buildReferer(base);
    tokenData = await requestServerToken(base, meta.tmdbId, referer);
  }

  const { serverToken, serverTs, xt } = tokenData;

  const params: Record<string, string> = {
    [F.id]: meta.tmdbId,
    b: type,
    [F.ts]: String(serverTs),
    [F.token]: serverToken,
    [F.fToken]: xt,
    [F.title]: meta.title,
    [F.year]: meta.year,
    date: meta.releaseDate,
    [F.imdbId]: meta.imdbId,
  };
  if (season != null && episode != null) {
    params[F.season] = String(season);
    params[F.episode] = String(episode);
  }
  const qs = new URLSearchParams(params).toString();

  const res = await fetch(`${base}/backend_/servers/${server}?${qs}`, {
    headers: { ...COMMON_HEADERS, Origin: base, Referer: referer },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    success?: boolean;
    links?: Array<{
      resolution?: number | string;
      source?: string;
      type?: string;
      size?: string;
      link?: string;
    }>;
  };
  if (!data.success || !Array.isArray(data.links)) return [];

  const requestHeaders = {
    Referer: referer,
    Origin: base,
    "User-Agent": COMMON_HEADERS["User-Agent"],
  };

  return data.links
    .filter((l) => l.link)
    .map((l) => ({
      server,
      type: (l.type as "mp4" | "hls") || (l.link!.includes(".m3u8") ? "hls" : "mp4"),
      resolution: l.resolution ?? (l.source && l.source !== "default" ? l.source : undefined) ?? "?",
      size: l.size,
      url: l.link!,
      requestHeaders,
    }));
}

/** Fetch all streams from all backend servers in parallel. */
export async function getAllStreams(
  type: "movie" | "tv",
  meta: Meta,
  season: number | null,
  episode: number | null,
): Promise<StreamLink[]> {
  const results = await Promise.allSettled(
    SERVERS.map((s) => fetchServer(s, meta, type, season, episode)),
  );
  const streams: StreamLink[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") streams.push(...r.value);
  }
  return streams;
}

/**
 * Berkas resolution values are 1..4 (SD→1080p+). Icarus returns numeric
 * heights like 480/720/1080. Normalize to a readable label.
 */
export function resolutionLabel(server: string, res: number | string): string {
  if (typeof res === "number" && res <= 4) {
    return ["360p", "480p", "720p", "1080p", "4K"][res] ?? `q${res}`;
  }
  return typeof res === "number" ? `${res}p` : String(res);
}

export function formatSize(bytes?: string): string {
  if (!bytes) return "";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "";
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}
