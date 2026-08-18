import { logger } from "../../lib/logger.js";
import { buildPlaylistProxyUrl, shouldProxySource } from "../../lib/hlsProxy.js";

const XPASS_BASE = "https://play.xpass.top";
const STREAM_REFERER = "https://streamsrcs.2embed.cc/";
const EMBED_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  Referer: STREAM_REFERER,
};

// Keep only the two requested DooFlix source hosts. Filtering by hostname
// prevents any other backup/CDN source from reaching Stremio.
const ALLOWED_SOURCE_HOSTNAMES = new Set([
  "vip.1x2.space",
  "mol.1x2.space",
]);

export interface DooflixStream {
  name: string;
  title: string;
  url: string;
  behaviorHints?: { notWebReady?: boolean };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function extractPrimaryPath(html: string): string | null {
  const match = html.match(/"playlist"\s*:\s*"(\/[^"]+)"/);
  return match?.[1] ?? null;
}

interface BackupEntry {
  name: string;
  url: string;
}

function extractBackups(html: string): BackupEntry[] {
  const start = html.indexOf("var backups=");
  if (start < 0) return [];

  const arrayStart = html.indexOf("[", start);
  if (arrayStart < 0) return [];

  // Count brackets instead of using a non-greedy regex. Backup entries can
  // contain nested JSON and a regex would truncate the real array.
  let depth = 0;
  let arrayEnd = -1;
  for (let index = arrayStart; index < html.length; index += 1) {
    if (html[index] === "[") depth += 1;
    if (html[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = index;
        break;
      }
    }
  }

  if (arrayEnd < 0) return [];

  try {
    const entries = JSON.parse(html.slice(arrayStart, arrayEnd + 1)) as Array<{
      name?: string;
      url?: string;
      dl?: boolean;
    }>;

    return entries
      .filter(
        (entry) =>
          entry.dl !== true &&
          typeof entry.name === "string" &&
          typeof entry.url === "string" &&
          entry.url.length > 0,
      )
      .map((entry) => ({ name: entry.name!, url: entry.url! }));
  } catch {
    return [];
  }
}

interface PlaylistSource {
  file: string;
  type?: string;
  label?: string;
}

function isAllowedSource(sourceFile: string): boolean {
  try {
    return ALLOWED_SOURCE_HOSTNAMES.has(new URL(sourceFile).hostname);
  } catch {
    return false;
  }
}

async function fetchPlaylistStreams(
  playlistUrl: string,
  embedUrl: string,
  proxyBase: string,
  sourceLabel?: string,
): Promise<DooflixStream[]> {
  const response = await fetchWithTimeout(playlistUrl, {
    headers: { ...EMBED_HEADERS, Referer: embedUrl },
    redirect: "follow",
  });

  if (!response.ok) return [];

  const json = (await response.json()) as {
    playlist?: Array<{ sources?: PlaylistSource[] }>;
  };
  const now = Math.floor(Date.now() / 1000);
  const streams: DooflixStream[] = [];

  for (const playlistItem of json.playlist ?? []) {
    for (const source of playlistItem.sources ?? []) {
      if (!source.file) continue;
      if (/\/video\/error\b/i.test(source.file) || source.file.trim() === "/video/error") {
        continue;
      }

      const expiration = source.file.match(/[?&]e=(\d+)/);
      if (expiration && Number.parseInt(expiration[1]!, 10) < now) {
        logger.debug({ file: source.file }, "DooFlix: skipping expired stream");
        continue;
      }

      if (!isAllowedSource(source.file)) {
        logger.debug({ file: source.file }, "DooFlix: skipping blocked or invalid source");
        continue;
      }

      const label = source.label ?? sourceLabel ?? "HD";

      // Region-locked hosts (e.g. VIP) answer this server but 404 for the
      // viewer's player, so hand out a relayed URL for those sources.
      const useProxy = proxyBase.length > 0 && shouldProxySource(source.file);
      const playbackUrl = useProxy
        ? buildPlaylistProxyUrl(proxyBase, source.file, embedUrl)
        : source.file;

      streams.push({
        name: `DooFlix\n${label}`,
        title: `▶ ${label} · HLS${useProxy ? " · relayed" : ""}`,
        url: playbackUrl,
        behaviorHints: { notWebReady: true },
      });
    }
  }

  return streams;
}

async function getXpassStreams(
  proxyBase: string,
  imdbId: string,
  kind: "movie" | "tv",
  season?: number,
  episode?: number,
): Promise<DooflixStream[]> {
  const embedUrl =
    kind === "movie"
      ? `${XPASS_BASE}/e/movie/${encodeURIComponent(imdbId)}`
      : `${XPASS_BASE}/e/tv/${encodeURIComponent(imdbId)}/${season}/${episode}`;

  logger.info({ embedUrl }, "DooFlix: fetching embed");

  const embedResponse = await fetchWithTimeout(embedUrl, {
    headers: EMBED_HEADERS,
    redirect: "follow",
  });
  if (!embedResponse.ok) {
    logger.warn({ embedUrl, status: embedResponse.status }, "DooFlix: embed fetch failed");
    return [];
  }

  const html = await embedResponse.text();
  const requests: Array<{ path: string; label?: string }> = [];
  const tried = new Set<string>();
  const primaryPath = extractPrimaryPath(html);

  if (primaryPath) {
    tried.add(primaryPath);
    requests.push({ path: primaryPath });
  }

  for (const backup of extractBackups(html)) {
    if (tried.has(backup.url)) continue;
    tried.add(backup.url);
    requests.push({ path: backup.url, label: backup.name });
    if (requests.length >= 8) break;
  }

  if (requests.length === 0) {
    logger.warn({ embedUrl }, "DooFlix: no playlist paths found in embed HTML");
    return [];
  }

  const results = await Promise.allSettled(
    requests.map(({ path, label }) =>
      fetchPlaylistStreams(`${XPASS_BASE}${path}`, embedUrl, proxyBase, label).catch((error) => {
        logger.warn({ error, path }, "DooFlix: playlist fetch error");
        return [] as DooflixStream[];
      }),
    ),
  );

  const seen = new Set<string>();
  const streams: DooflixStream[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const stream of result.value) {
      if (seen.has(stream.url)) continue;
      seen.add(stream.url);
      streams.push(stream);
    }
  }

  logger.info({ embedUrl, count: streams.length }, "DooFlix: streams fetched");
  return streams;
}

export function getDooflixMovieStreams(
  proxyBase: string,
  imdbId: string,
): Promise<DooflixStream[]> {
  return getXpassStreams(proxyBase, imdbId, "movie");
}

export function getDooflixSeriesStreams(
  proxyBase: string,
  imdbId: string,
  season: number,
  episode: number,
): Promise<DooflixStream[]> {
  return getXpassStreams(proxyBase, imdbId, "tv", season, episode);
}