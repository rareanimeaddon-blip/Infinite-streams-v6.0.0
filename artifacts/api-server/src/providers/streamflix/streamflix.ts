import { logger } from "../../lib/logger";

const API_BASE = "https://api.streamflix.app";
const FIREBASE_BASE =
  "https://chilflix-410be-default-rtdb.asia-southeast1.firebasedatabase.app";

// Newest app config first: the legacy config still advertises the retired
// cf./bb.streamflixserver.site hosts, which no longer resolve (ERR_NAME_NOT_RESOLVED).
const CONFIG_URLS = [
  `${API_BASE}/config/config-streamflix2.json`,
  `${API_BASE}/config/config-streamflixapp.json`,
];

// Last-resort base if every remote config is unreachable.
const FALLBACK_BASES = ["https://stream.streamflixserver.site/"];

const DATA_TTL = 30 * 60 * 1000;
const CONFIG_TTL = 5 * 60 * 1000;
const EPISODES_TTL = 60 * 60 * 1000;
const PROBE_TTL = 10 * 60 * 1000;

interface StreamflixItem {
  isTV: boolean;
  moviename: string;
  movielink?: string;
  moviekey: string;
  tmdb?: string;
}

interface StreamflixConfig {
  download?: string[];
  movies?: string[];
  tv?: string[];
  premium?: string[];
}

interface EpisodeData {
  link: string;
  name?: string;
}

let dataCache: { items: StreamflixItem[]; ts: number } | null = null;
let basesCache: { bases: string[]; ts: number } | null = null;
const episodesCache = new Map<
  string,
  { episodes: Record<number, EpisodeData>; ts: number }
>();
const probeCache = new Map<string, { ok: boolean; ts: number }>();

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Upstream request failed: ${response.status} ${url}`);
  }

  return (await response.json()) as T;
}

async function getData(): Promise<StreamflixItem[]> {
  if (dataCache && Date.now() - dataCache.ts < DATA_TTL) return dataCache.items;

  logger.info("streamflix: fetching data.json");
  const payload = await getJson<{ data?: StreamflixItem[] }>(
    `${API_BASE}/data.json`,
    20_000,
  );
  const items = payload.data ?? [];
  dataCache = { items, ts: Date.now() };
  logger.info({ count: items.length }, "streamflix: data.json cached");
  return items;
}

function normalizeBase(base: string): string | null {
  const value = base?.trim();
  if (!value || !/^https?:\/\//i.test(value)) return null;
  return value.endsWith("/") ? value : `${value}/`;
}

/** Collect CDN bases from every known config, newest config first. */
async function getBases(): Promise<string[]> {
  if (basesCache && Date.now() - basesCache.ts < CONFIG_TTL) {
    return basesCache.bases;
  }

  const bases: string[] = [];
  for (const url of CONFIG_URLS) {
    try {
      const config = await getJson<StreamflixConfig>(url, 8_000);
      for (const list of [
        config.download,
        config.movies,
        config.tv,
        config.premium,
      ]) {
        for (const entry of list ?? []) {
          const normalized = normalizeBase(entry);
          if (normalized && !bases.includes(normalized)) bases.push(normalized);
        }
      }
    } catch (error) {
      logger.warn({ error, url }, "streamflix: config fetch failed");
    }
  }

  for (const fallback of FALLBACK_BASES) {
    const normalized = normalizeBase(fallback);
    if (normalized && !bases.includes(normalized)) bases.push(normalized);
  }

  basesCache = { bases, ts: Date.now() };
  return bases;
}

/**
 * Verify a base actually serves the file. Dead hosts (DNS failures such as
 * cf.streamflixserver.site) are dropped so Stremio never offers a broken link.
 */
async function probe(url: string): Promise<boolean> {
  const host = new URL(url).host;
  const cached = probeCache.get(host);
  if (cached && Date.now() - cached.ts < PROBE_TTL) return cached.ok;

  let ok = false;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { ...REQUEST_HEADERS, Range: "bytes=0-1" },
      signal: AbortSignal.timeout(8_000),
    });
    ok = response.status === 200 || response.status === 206;
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
  } catch (error) {
    logger.debug({ error, host }, "streamflix: base probe failed");
    ok = false;
  }

  probeCache.set(host, { ok, ts: Date.now() });
  return ok;
}

async function filterPlayable(urls: string[]): Promise<string[]> {
  const results = await Promise.all(
    urls.map(async (url) => ((await probe(url)) ? url : null)),
  );
  const playable = results.filter((url): url is string => url !== null);
  return playable.length > 0 ? playable : [];
}

function subtitleHint(filename: string): string {
  const value = filename.toLowerCase();
  return value.includes("esub") ||
    value.includes(".srt") ||
    value.includes(".ass") ||
    value.includes("sub")
    ? " [Embedded Subs]"
    : "";
}

export interface StreamflixStream {
  url: string;
  name: string;
  title: string;
  behaviorHints?: {
    notWebReady?: boolean;
  };
}

function buildStreams(
  urls: string[],
  label: string,
  subs: string,
): StreamflixStream[] {
  return urls.map((url, index) => ({
    url,
    name: "StreamFlix",
    title: `StreamFlix${index > 0 ? ` Mirror ${index}` : ""}${subs} | ${label}`,
    behaviorHints: { notWebReady: true },
  }));
}

export async function fetchStreamflixStreams(
  tmdbId: number,
  type: "movie" | "series",
  season: number | null,
  episode: number | null,
): Promise<StreamflixStream[]> {
  try {
    const [items, bases] = await Promise.all([getData(), getBases()]);
    const match = items.find((item) => item.tmdb === String(tmdbId));

    if (!match) {
      logger.info({ tmdbId }, "streamflix: no match found");
      return [];
    }

    if (bases.length === 0) {
      logger.warn({ tmdbId }, "streamflix: no download CDN bases in config");
      return [];
    }

    const toUrls = (link: string) =>
      bases.map((base) => `${base}${link.replace(/^\/+/, "")}`);

    if (type === "movie") {
      if (!match.movielink) return [];
      const urls = await filterPlayable(toUrls(match.movielink));
      if (urls.length === 0) {
        logger.warn(
          { tmdbId, link: match.movielink },
          "streamflix: no reachable CDN host for movie",
        );
        return [];
      }
      return buildStreams(urls, match.moviename, subtitleHint(match.movielink));
    }

    if (season === null || episode === null) return [];

    try {
      const episodes = await getEpisodes(match.moviekey, season);
      const episodeData = episodes[episode - 1] ?? episodes[episode];
      if (!episodeData?.link) return [];

      const urls = await filterPlayable(toUrls(episodeData.link));
      if (urls.length === 0) {
        logger.warn(
          { tmdbId, season, episode },
          "streamflix: no reachable CDN host for episode",
        );
        return [];
      }

      const label = `${match.moviename} S${season}E${episode}${
        episodeData.name ? ` • ${episodeData.name}` : ""
      }`;
      return buildStreams(urls, label, subtitleHint(episodeData.link));
    } catch (error) {
      logger.debug(
        { error, movieKey: match.moviekey, season },
        "streamflix: episode lookup failed",
      );
      return [];
    }
  } catch (error) {
    logger.warn({ error, tmdbId }, "streamflix: provider error");
    return [];
  }
}

async function getEpisodes(
  movieKey: string,
  season: number,
): Promise<Record<number, EpisodeData>> {
  const cacheKey = `${movieKey}:${season}`;
  const cached = episodesCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < EPISODES_TTL) return cached.episodes;

  const raw = await getJson<Record<string, EpisodeData>>(
    `${FIREBASE_BASE}/Data/${encodeURIComponent(movieKey)}/seasons/${season}/episodes.json`,
    10_000,
  );
  const episodes: Record<number, EpisodeData> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const episodeNumber = Number.parseInt(key, 10);
    if (Number.isFinite(episodeNumber)) episodes[episodeNumber] = value;
  }
  episodesCache.set(cacheKey, { episodes, ts: Date.now() });
  return episodes;
}
