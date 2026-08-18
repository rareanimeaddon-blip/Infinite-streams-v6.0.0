/**
 * MoviesDrive scraper + stream extractor (Standalone Stremio Addon Engine)
 */

import { findBestMatch, type MatchCandidate } from "./match.js";
import { logger } from "./logger.js";

// Working domain as of 2026-08-16: new2.moviesdrive.christmas
// Fallback domains: new1.moviesdrive.christmas, moviesdrives.mov, moviesdrive.space
const DOMAIN_CANDIDATES = [
  "https://new2.moviesdrive.christmas",
  "https://new1.moviesdrive.christmas",
  "https://moviesdrives.mov",
  "https://moviesdrive.space",
];
let MAIN_URL = DOMAIN_CANDIDATES[0];
const ARCHIVE_DOMAIN = "https://mdrive.lol";

const MOBILE_UAS = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36",
];

function pickUA(): string {
  return MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "–");
}

function isSafeHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host)
  ) return null;
  return u;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(
  url: string,
  opts: { headers?: Record<string, string>; timeout?: number; retries?: number } = {}
): Promise<string | null> {
  const parsed = isSafeHttpsUrl(url);
  if (!parsed) return null;
  const timeout = opts.timeout ?? 12000;
  const retries = opts.retries ?? 2;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(parsed.href, {
        headers: {
          "User-Agent": pickUA(),
          "Accept-Language": "en-US,en;q=0.9",
          ...(opts.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        return null;
      }
      return await res.text();
    } catch {
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

async function fetchJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeout?: number } = {}
): Promise<T | null> {
  const text = await fetchText(url, opts);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function extractBaseTitle(fullTitle: string): string {
  const withYear = fullTitle.match(/^(.+?)\s*\(\d{4}\)/);
  if (withYear) return withYear[1]!.trim();
  return fullTitle.replace(
    /\s+(1080p|720p|480p|4K|4k|BluRay|WEB-DL|WEBRip|WEB\s+DL|HDTV|DVDRip|iMAX|\[).*/i,
    "",
  ).trim();
}

export interface SiteResult {
  title: string;
  href: string;
  year: number | null;
  imdb: string | null;
  content?: string;
}

export interface StreamLink {
  url: string;
  quality: string;
  size: string;
  host: string;
  type: "FSL" | "FSLv2" | "R2" | "GPDL" | "Workers";
  title: string;
  matchedTitle?: string;
  idVerified?: boolean;
}

interface ArchiveLink {
  url: string;
  quality: string;
  size: string;
}

interface HostLink {
  url: string;
}

function parseQuality(label: string): string {
  const s = String(label || "");
  const m = s.match(/(2160|1080|720|480)\s*P/i);
  if (m) return m[1] + "p";
  if (/4K|UHD/i.test(s)) return "2160p";
  if (/1440|2K/i.test(s)) return "1440p";
  return "HD";
}

const QUALITY_RANK: Record<string, number> = { "2160p": 4, "1440p": 3.5, "1080p": 3, "720p": 2, HD: 1 };

export function isStrictMatch(
  searchTitle: string,
  searchYear: string | number | undefined,
  candidateTitle: string,
  candidateYear: number | string | null | undefined
): boolean {
  if (!searchTitle || !candidateTitle) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().replace(/\s+/g, " ");
  const st = norm(searchTitle);
  const ct = norm(String(candidateTitle).replace(/download\s*/gi, ""));

  const isWholePhrase =
    ct === st ||
    ct.indexOf(st + " ") === 0 ||
    ct.indexOf(" " + st + " ") !== -1 ||
    ct.indexOf(" " + st) === ct.length - st.length - 1;
  if (!isWholePhrase) return false;

  if (searchYear && candidateYear) {
    const a = parseInt(String(searchYear));
    const b = parseInt(String(candidateYear));
    if (!isNaN(a) && !isNaN(b) && Math.abs(a - b) > 1) return false;
  }
  return true;
}

function extractSeasonHtml(html: string, season: number): string | null {
  const headingRe =
    /(<h[1-6][^>]*>|<strong[^>]*>|<span[^>]*>)[\s\S]{0,100}?(?:Season|Saison|Staffel)\s*0*(\d+)\b(?!\s*[-–+&])/gi;
  const marks: { index: number; season: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    marks.push({ index: m.index, season: parseInt(m[2]) });
  }

  let startIdx = -1;
  let lastOtherIdx = -1;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].season === season) {
      if (startIdx === -1) startIdx = i;
    } else {
      lastOtherIdx = i;
    }
  }

  if (startIdx === -1) {
    const rangeRe = /(<h[1-6][^>]*>|<strong[^>]*>).*?(?:Season|Saison|Staffel)\s*0*(\d+)\s*[-–]\s*0*(\d+)/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rangeRe.exec(html)) !== null) {
      if (season >= parseInt(rm[2]) && season <= parseInt(rm[3])) {
        return html.substring(rm.index);
      }
    }
    return null;
  }

  let startPos = marks[startIdx].index;
  if (lastOtherIdx > startIdx) {
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].season === season && i > lastOtherIdx) {
        startPos = marks[i].index;
        break;
      }
    }
  }

  let endPos = html.length;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].index > startPos && marks[i].season !== season) {
      endPos = marks[i].index;
      break;
    }
  }

  return html.substring(startPos, endPos);
}

interface SearchHit {
  document?: { permalink?: string; post_title?: string; imdb_id?: string };
}

interface WpPost {
  title: { rendered: string };
  link: string;
  content?: { rendered: string };
}

function stripHtmlEntities(s: string): string {
  return decodeHtml(s).replace(/<[^>]+>/g, "").trim();
}

export async function searchSiteWpRest(query: string): Promise<SiteResult[]> {
  for (const base of DOMAIN_CANDIDATES) {
    const url = `${base}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=15&_fields=title,link,content`;
    const json = await fetchJson<WpPost[]>(url, {
      headers: { Accept: "application/json" },
      timeout: 10000,
    });
    if (json && Array.isArray(json) && json.length > 0) {
      MAIN_URL = base;
      return json.map((post) => {
        const title = stripHtmlEntities(post.title.rendered);
        const yearMatch = title.match(/\((\d{4})\)/);
        return {
          title,
          href: post.link,
          year: yearMatch ? parseInt(yearMatch[1]) : null,
          imdb: null,
          content: post.content?.rendered,
        };
      });
    }
  }
  return [];
}

async function searchSiteTypesense(query: string): Promise<SiteResult[]> {
  for (const base of DOMAIN_CANDIDATES) {
    const url = `${base}/search.php?q=${encodeURIComponent(query)}&per_page=10`;
    const json = await fetchJson<{ hits?: SearchHit[] }>(url, {
      headers: { Referer: `${base}/` },
      timeout: 8000,
    });
    if (json?.hits && Array.isArray(json.hits) && json.hits.length > 0) {
      const results: SiteResult[] = [];
      for (const hit of json.hits) {
        const doc = hit.document;
        if (!doc?.permalink || !doc?.post_title) continue;
        const yearMatch = doc.post_title.match(/\((\d{4})\)/);
        results.push({
          title: doc.post_title,
          href: doc.permalink,
          year: yearMatch ? parseInt(yearMatch[1]) : null,
          imdb: doc.imdb_id || null,
        });
      }
      if (results.length > 0) return results;
    }
  }
  return [];
}

export async function searchSite(query: string): Promise<SiteResult[]> {
  const wpResults = await searchSiteWpRest(query);
  if (wpResults.length > 0) return wpResults;
  return searchSiteTypesense(query);
}

function resolveHref(href: string): string {
  return href.indexOf("http") === 0 ? href : `${MAIN_URL}${href}`;
}

function extractArchiveLinks(html: string, season?: number): ArchiveLink[] {
  const seasonScoped = season != null;
  const scoped = seasonScoped ? extractSeasonHtml(html, season!) : html;
  if (!scoped) return [];

  const links: ArchiveLink[] = [];
  const re = /href="(https?:\/\/mdrive\.lol\/archive\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scoped)) !== null) {
    const label = m[2].replace(/<[^>]+>/g, "").trim();
    if (seasonScoped && /zip/i.test(label)) continue;
    const quality = parseQuality(label);
    if (quality === "480p") continue;
    const sizeMatch = label.match(/\[([\d.]+)\s*(MB|GB|TB)\]/i);
    links.push({ url: m[1], quality, size: sizeMatch ? sizeMatch[0] : "" });
  }
  return links;
}

interface SearchRecoverLink {
  url: string;
  quality: string;
  size: string;
}

function extractSearchRecoverLinks(html: string): SearchRecoverLink[] {
  const links: SearchRecoverLink[] = [];
  const re = /href="(https?:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawUrl = m[1].replace(/&amp;/g, "&");
    const label = m[2].replace(/<[^>]+>/g, "").trim();
    const preceding = html.slice(Math.max(0, m.index - 400), m.index)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const qualityMatch = (label + " " + preceding).match(/((?:\d+p)(?:[^[\]]{0,30})?(?:\[[\d.]+\s*[MGBT]+\])?)/i);
    const quality = qualityMatch ? parseQuality(qualityMatch[1]) : parseQuality(label);
    const sizeMatch = (label + " " + preceding).match(/\[([\d.]+\s*(?:MB|GB|TB))\]/i);
    const size = sizeMatch ? `[${sizeMatch[1]}]` : "";
    links.push({ url: rawUrl, quality, size });
  }
  return links;
}

interface SearchRecoverHit {
  file_name?: string;
  url?: string;
  size?: string;
  mimeType?: string;
}

async function callSearchRecoverApi(
  fromAc: string,
  query: string,
  refererUrl: string,
): Promise<SearchRecoverHit[]> {
  const apiUrl = `https://hubcloud.cx/drive/search-recover.php?${new URLSearchParams({
    api: "search",
    q: query,
    page: "1",
    from_ac: fromAc,
  }).toString()}`;

  const parsed = isSafeHttpsUrl(apiUrl);
  if (!parsed) return [];

  try {
    const res = await fetch(parsed.href, {
      headers: {
        "User-Agent": pickUA(),
        "Accept": "application/json",
        "Referer": refererUrl,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { hits?: SearchRecoverHit[] };
    return json.hits ?? [];
  } catch {
    return [];
  }
}

async function resolveSearchRecoverLinks(
  srLinks: SearchRecoverLink[],
  episode?: number,
): Promise<{ url: string; quality: string; size: string }[]> {
  const results: { url: string; quality: string; size: string }[] = [];
  const seen = new Set<string>();

  await Promise.allSettled(
    srLinks.map(async (link) => {
      let fromAc: string | null = null;
      let queryB64: string | null = null;
      try {
        const u = new URL(link.url);
        fromAc = u.searchParams.get("from_ac");
        queryB64 = u.searchParams.get("q");
      } catch { return; }
      if (!fromAc) return;

      let query = "";
      try { query = queryB64 ? Buffer.from(queryB64, "base64").toString("utf-8") : ""; } catch { /* ignore */ }

      const hits = await callSearchRecoverApi(fromAc, query, link.url);

      for (const hit of hits) {
        if (!hit.url) continue;
        const fn = (hit.file_name ?? "").toLowerCase();
        if (/\.(zip|rar|7z|tar|gz|nfo|srt|ass|sub)$/i.test(fn)) continue;

        if (episode != null) {
          const epMatch = fn.match(/[se]\d+[ex]0*(\d+)|episode\s*0*(\d+)|ep\.?\s*0*(\d+)/i);
          if (epMatch) {
            const epNum = parseInt(epMatch[1] ?? epMatch[2] ?? epMatch[3]);
            if (epNum !== episode) continue;
          }
        }

        const url = hit.url;
        if (!seen.has(url)) {
          seen.add(url);
          const hitQuality = hit.file_name ? parseQuality(hit.file_name) : "HD";
          const finalQuality = hitQuality !== "HD" ? hitQuality : (link.quality !== "HD" ? link.quality : (query ? parseQuality(query) : "HD"));
          const size = hit.size ? `[${hit.size}]` : link.size;
          results.push({ url, quality: finalQuality, size });
        }
      }
    })
  );
  return results;
}

async function extractHostLinks(archiveUrl: string, episode?: number): Promise<HostLink[]> {
  const html = await fetchText(archiveUrl, { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
  if (!html) return [];

  const links: HostLink[] = [];
  const re = /https?:\/\/hubcloud\.[a-z]+\/drive\/[a-z0-9_]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (episode != null) {
      const windowStart = Math.max(0, m.index - 300);
      const preceding = html.substring(windowStart, m.index);
      const epRe = /(?:EP|Episode|E)\D*0*(\d+)/gi;
      let epMatch: RegExpExecArray | null;
      let lastEp = -1;
      while ((epMatch = epRe.exec(preceding)) !== null) {
        lastEp = parseInt(epMatch[1]);
      }
      if (lastEp === -1 || lastEp !== episode) continue;
    }
    links.push({ url: m[0] });
  }
  return links;
}

function decodeBase64(s: string): string {
  return Buffer.from(s, "base64").toString("utf-8");
}

function minuteToken(): string {
  return String(new Date().getMinutes());
}

async function resolveHubcloud(
  hubUrl: string,
  quality: string,
  size: string
): Promise<StreamLink[]> {
  const page1 = await fetchText(hubUrl, {
    headers: { Cookie: "xla=s4t", Referer: `${ARCHIVE_DOMAIN}/` },
    timeout: 12000,
  });
  if (!page1) return [];

  let nextUrl: string | null = null;
  const varMatch = page1.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
  if (varMatch) {
    nextUrl = varMatch[1];
  } else {
    const aMatch = page1.match(/<a\s+id="download"\s+(?:x-href|href)="([^"]+)"/);
    if (aMatch) {
      nextUrl = aMatch[1];
    }
  }
  if (!nextUrl) return [];

  if (!nextUrl.startsWith("http")) {
    try { nextUrl = decodeBase64(nextUrl); } catch { /* ignore */ }
  }

  const page2 = await fetchText(nextUrl, {
    headers: { Cookie: "xla=s4t", Referer: hubUrl },
    timeout: 15000,
  });
  if (!page2) return [];

  const results: StreamLink[] = [];
  const decoded = decodeHtml(page2);

  // 1. FSLv2 (fsl.gigabytes.icu)
  const fslv2Re = /href="(https?:\/\/fsl\.gigabytes\.icu[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = fslv2Re.exec(decoded)) !== null) {
    results.push({ url: m[1], quality, size, host: "hubcloud", type: "FSLv2", title: "" });
  }

  // 2. FSL CDN (.buzz, .beer, pub-*.r2.dev)
  const minTok = minuteToken();
  const fslRe = /href="(https?:\/\/(?:pub-[a-z0-9]+\.r2\.dev|[a-z0-9.]+\.(?:buzz|beer))[^"]+)"/gi;
  while ((m = fslRe.exec(decoded)) !== null) {
    const raw = m[1];
    const url = raw.includes("?token=") ? raw : `${raw}1${minTok}`;
    results.push({ url, quality, size, host: "hubcloud", type: "FSL", title: "" });
  }

  // 3. Direct video URLs with token
  const videoTokenRe = /href="(https?:\/\/[^"]+\.(?:mkv|mp4|avi|webm)\?token=\d+[^"]*)"/gi;
  while ((m = videoTokenRe.exec(decoded)) !== null) {
    results.push({ url: m[1], quality, size, host: "hubcloud", type: "FSL", title: "" });
  }

  // 4. Cloudflare R2 direct presigned links (in href or host: '...')
  const r2Re = /(?:href="|host:\s*['"])(https?:\/\/[a-z0-9.-]*\.r2\.cloudflarestorage\.com\/[^"'\s]+)/gi;
  let r2m: RegExpExecArray | null;
  while ((r2m = r2Re.exec(decoded)) !== null) {
    results.push({ url: r2m[1], quality, size, host: "hubcloud", type: "R2", title: "" });
  }

  // 5. Cloudflare Workers direct video streams (.mkv / .mp4, skipping .zip)
  const workersRe = /href="(https?:\/\/[a-z0-9.-]+\.workers\.dev\/[^"]+)"/gi;
  let wm: RegExpExecArray | null;
  while ((wm = workersRe.exec(decoded)) !== null) {
    const url = wm[1];
    if (/\.zip(?:["?]|$)/i.test(url)) continue;
    if (/\.(mkv|mp4|avi|webm)(?:["?]|$)/i.test(url) || url.includes(".mkv") || url.includes(".mp4")) {
      results.push({ url, quality, size, host: "hubcloud", type: "Workers", title: "" });
    }
  }

  // 6. GPDL links
  const gpdlRe = /href="(https?:\/\/gpdl\d*\.hubcloud\.[a-z]+\/\?id=[^"]+)"/gi;
  let gm: RegExpExecArray | null;
  while ((gm = gpdlRe.exec(decoded)) !== null) {
    results.push({ url: gm[1], quality, size, host: "hubcloud", type: "GPDL", title: "" });
  }

  return results;
}

export interface GetStreamsParams {
  title: string;
  year?: string;
  imdbId?: string | null;
  type: "movie" | "series";
  season?: number;
  episode?: number;
}

export async function getMoviesDriveStreams(params: GetStreamsParams): Promise<StreamLink[]> {
  const { title, year, imdbId, type, season, episode } = params;
  const isSeries = type === "series";

  let matched: SiteResult | null = null;
  let matchedHtml: string | null = null;
  let matchedViaImdbId = false;

  // Pass 1: search by IMDB id if we have one
  if (imdbId && imdbId.startsWith("tt")) {
    const hits = await searchSite(imdbId);
    for (const hit of hits) {
      if (hit.imdb !== imdbId) continue;
      if (isSeries && season != null) {
        const html = hit.content ?? await fetchText(resolveHref(hit.href), { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
        if (html && extractSeasonHtml(html, season) !== null) {
          matched = hit;
          matchedHtml = html;
          matchedViaImdbId = true;
          break;
        }
      } else {
        matched = hit;
        matchedHtml = hit.content ?? null;
        matchedViaImdbId = true;
        break;
      }
    }
  }

  // Pass 2: search by title
  if (!matched) {
    const cleanSearchQuery = title.replace(/[:\-]/g, " ").replace(/\s+/g, " ").trim();
    const hits = await searchSite(cleanSearchQuery || title);
    if (hits.length > 0) {
      const matchCandidates: MatchCandidate<SiteResult>[] = hits.map((hit) => {
        const cleanTitle = hit.title.replace(/^Download\s*[-–:]?\s*/i, "").trim();
        return {
          title: cleanTitle,
          year: hit.year ?? undefined,
          type,
          raw: hit,
        };
      });
      const yearNum = year ? parseInt(String(year)) : undefined;
      const { best: bestHit } = findBestMatch(
        { title, year: yearNum, type, season, episode },
        matchCandidates,
        { provider: "MoviesDrive", query: title },
      );
      if (bestHit) {
        const hit = bestHit.raw;
        if (isSeries && season != null) {
          const html = hit.content ?? await fetchText(resolveHref(hit.href), { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
          if (html && extractSeasonHtml(html, season) !== null) {
            matched = hit;
            matchedHtml = html;
          }
        } else {
          matched = hit;
          matchedHtml = hit.content ?? null;
        }
      }
    }
  }

  if (!matched) return [];

  if (!matchedHtml) {
    matchedHtml = await fetchText(resolveHref(matched.href), { headers: { Referer: `${MAIN_URL}/` }, timeout: 12000 });
    if (!matchedHtml) return [];
  }

  const hostJobs: { url: string; quality: string; size: string }[] = [];

  // Path A: old mdrive.lol archive format
  const archiveLinks = extractArchiveLinks(matchedHtml, isSeries ? season : undefined);
  if (archiveLinks.length > 0) {
    for (const archive of archiveLinks) {
      const hostLinks = await extractHostLinks(archive.url, isSeries ? episode : undefined);
      for (const hl of hostLinks) hostJobs.push({ url: hl.url, quality: archive.quality, size: archive.size });
    }
  } else {
    // Path B: new search-recover format
    const srLinks = extractSearchRecoverLinks(matchedHtml);
    if (srLinks.length > 0) {
      const srJobs = await resolveSearchRecoverLinks(srLinks, isSeries ? episode : undefined);
      hostJobs.push(...srJobs);
    }
  }

  if (!hostJobs.length) return [];

  const BATCH = 4;
  const streams: StreamLink[] = [];
  for (let i = 0; i < hostJobs.length; i += BATCH) {
    const batch = hostJobs.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((job) => resolveHubcloud(job.url, job.quality, job.size))
    );
    for (const r of results) {
      if (r.status === "fulfilled") streams.push(...r.value);
    }
  }

  const cleanedMatchTitle = extractBaseTitle(matched.title);
  for (const s of streams) {
    s.matchedTitle = cleanedMatchTitle;
    if (matchedViaImdbId) s.idVerified = true;
  }

  const seen = new Set<string>();
  const deduped = streams.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  deduped.sort((a, b) => {
    const aV2 = a.type === "FSLv2" ? 1 : 0;
    const bV2 = b.type === "FSLv2" ? 1 : 0;
    if (aV2 !== bV2) return bV2 - aV2;
    return (QUALITY_RANK[b.quality] || 0) - (QUALITY_RANK[a.quality] || 0);
  });

  return deduped;
}

// Backwards-compatible alias for the api-server route layer.
export { getMoviesDriveStreams as getStreams };
