/**
 * NetMirror provider.
 *
 * This is the fixed NetMirror implementation adapted to Infinite Streams'
 * provider contract. It deliberately owns its API discovery, platform
 * resolution, caching, and stream shape inside this folder.
 */

import { logger } from "../../lib/logger.js";

const TMDB_API_KEY =
  process.env["TMDB_API_KEY"] ?? "5f39fd16e987a9e3fce30d55cf09b438";
const STREAM_CACHE_TTL = 25 * 60 * 1000;
const PLATFORM_ORDER = ["netflix", "primevideo", "hotstar", "disney"] as const;
type Platform = (typeof PLATFORM_ORDER)[number];

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36",
];
const ACCEPT_LANG_POOL = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-IN,en;q=0.9,hi;q=0.7",
  "en-US,en;q=0.8,es;q=0.5",
];
let uaIndex = 0;
let langIndex = 0;

function nextUA(): string {
  return UA_POOL[uaIndex++ % UA_POOL.length]!;
}

function nextLang(): string {
  return ACCEPT_LANG_POOL[langIndex++ % ACCEPT_LANG_POOL.length]!;
}

export interface NetMirrorSubtitle {
  id: string;
  url: string;
  lang: string;
  label?: string;
}

export interface NetMirrorStream {
  name: string;
  title: string;
  url: string;
  subtitles?: NetMirrorSubtitle[];
  behaviorHints?: {
    notWebReady?: boolean;
    headers?: Record<string, string>;
  };
}

interface CacheEntry {
  streams: NetMirrorStream[];
  expiresAt: number;
}

export interface NetMirrorConfig {
  preferredPlatform?: Platform | "all";
  forceHd?: boolean;
}

const streamCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<NetMirrorStream[]>>();
let resolvedApiUrl = "";

const NEW_TV_DOMAINS = [
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==",
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==",
];

const PLATFORM_MAP: Record<Platform, { ott: string }> = {
  netflix: { ott: "nf" },
  primevideo: { ott: "pv" },
  hotstar: { ott: "hs" },
  disney: { ott: "hs" },
};

function apiBase(): string {
  return (process.env["NETMIRROR_API_BASE"] ?? "https://net27.cc").replace(
    /\/$/,
    "",
  );
}

function streamReferer(): string {
  return (
    process.env["NETMIRROR_STREAM_REFERER"] ??
    "https://videodownloader.site/"
  );
}

function newTvHeaders(
  ott: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "X-Requested-With": "NetmirrorNewTV v1.0",
    Accept: "application/json, text/plain, */*",
    Ott: ott,
    "User-Agent": nextUA(),
    "Accept-Language": nextLang(),
    ...extra,
  };
}

async function resolveNewTvApi(): Promise<string> {
  if (resolvedApiUrl) return resolvedApiUrl;
  const custom = (process.env["NEWTV_DOMAINS"] ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const domains = [
    ...custom,
    ...NEW_TV_DOMAINS.map((value) =>
      Buffer.from(value, "base64").toString("utf8"),
    ),
  ];

  for (const domain of domains) {
    try {
      const response = await fetch(`${domain}/checknewtv.php`, {
        headers: { ...newTvHeaders("nf") },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as { token_hash?: string };
      if (data.token_hash) {
        resolvedApiUrl = Buffer.from(data.token_hash, "base64")
          .toString("utf8")
          .replace(/\/$/, "");
        return resolvedApiUrl;
      }
    } catch {
      // Try the next rotating discovery domain.
    }
  }
  throw new Error("NetMirror NewTV API discovery failed");
}

export function clearAllCaches(): void {
  resolvedApiUrl = "";
  streamCache.clear();
  inflight.clear();
}

export async function imdbToTmdb(
  imdbId: string,
  type: "movie" | "series",
): Promise<{ tmdbId: number; title: string } | null> {
  try {
    const response = await fetch(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
      {
        headers: { Accept: "application/json", "User-Agent": nextUA() },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      movie_results?: Array<{ id: number; title?: string }>;
      tv_results?: Array<{ id: number; name?: string }>;
    };
    const result =
      type === "series" ? data.tv_results?.[0] : data.movie_results?.[0];
    if (!result) return null;
    const title =
      "name" in result
        ? result.name ?? ""
        : "title" in result
          ? result.title ?? ""
          : "";
    return { tmdbId: result.id, title };
  } catch {
    return null;
  }
}

async function fetchNetflix(
  tmdbId: number,
  type: "movie" | "series",
  title: string,
  season: number | null,
  episode: number | null,
): Promise<NetMirrorStream[]> {
  try {
    const base = apiBase();
    const url =
      type === "series"
        ? `${base}/api/embed-tmdb/${tmdbId}?type=tv&se=${season}&ep=${episode}`
        : `${base}/api/embed-tmdb/${tmdbId}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: `${base}/`,
        "User-Agent": nextUA(),
        "Accept-Language": nextLang(),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      ok?: boolean;
      mp4?: string;
      streams?: Array<{ url: string; resolution?: number }>;
      captions?: Array<{ url: string; lang?: string; name?: string }>;
    };
    if (data.ok !== true) return [];
    const subtitles = (data.captions ?? []).flatMap((caption, index) => {
      if (!caption.url) return [];
      return [
        {
          id: `netflix-${index}-${caption.lang ?? "en"}`,
          url: caption.url.startsWith("/")
            ? `${base}${caption.url}`
            : caption.url,
          lang: caption.lang ?? "en",
          label: caption.name ?? "English",
        },
      ];
    });
    const headers = { Referer: streamReferer(), "User-Agent": nextUA() };
    const streams = (data.streams ?? []).filter((stream) => stream.url).map(
      (stream) => ({
        name: "NetMirror | Netflix",
        title: `${title}\n${stream.resolution ? `${stream.resolution}p` : "Auto"}`,
        url: stream.url,
        subtitles,
        behaviorHints: { notWebReady: true, headers },
      }),
    );
    if (streams.length || !data.mp4) return streams;
    return [
      {
        name: "NetMirror | Netflix",
        title: `${title}\nAuto`,
        url: data.mp4,
        subtitles,
        behaviorHints: { notWebReady: true, headers },
      },
    ];
  } catch (error) {
    logger.debug({ err: error, tmdbId }, "NetMirror: Netflix direct failed");
    return [];
  }
}

interface EpisodeEntry {
  id: string;
  s: number | null;
  ep: number | null;
}

interface NetMirrorSeason {
  id: string;
  s?: string;
  selected?: boolean;
}

interface NetMirrorEpisode {
  id: string;
  ep?: string;
  epNum?: string;
  sNum?: string;
  s?: string;
  info?: string[];
}

function parseNumber(value?: string): number | null {
  if (!value) return null;
  const parsed = parseInt(value.replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSeasonLabel(value: string | undefined, fallback: number): number {
  const match = value?.match(/season\s*(\d+)/i);
  return match ? Number(match[1]) : fallback;
}

async function getEpisodes(
  api: string,
  showId: string,
  postData: {
    season?: NetMirrorSeason[];
    nextPageSeason?: string;
    nextPageShow?: number;
    episodes?: Array<NetMirrorEpisode | null>;
  },
  config: { ott: string },
  requestedSeason: number | null,
): Promise<EpisodeEntry[]> {
  const result: EpisodeEntry[] = [];
  const seasons = postData.season ?? [];
  const selectedSeasonIndex = seasons.findIndex((item) => item.selected);
  const requestedSeasonIndex =
    requestedSeason === null
      ? -1
      : seasons.findIndex(
          (item, index) =>
            parseSeasonLabel(item.s, index + 1) === requestedSeason,
        );
  const targetSeasonIndex =
    requestedSeasonIndex >= 0 ? requestedSeasonIndex : selectedSeasonIndex;
  const targetSeason = seasons[targetSeasonIndex];
  const targetSeasonId =
    targetSeason?.id ??
    (postData.nextPageSeason && targetSeasonIndex < 0
      ? postData.nextPageSeason
      : undefined);
  const fallbackSeason =
    requestedSeason ??
    (targetSeasonIndex >= 0 ? targetSeasonIndex + 1 : null);

  const add = (
    episode: NetMirrorEpisode,
    seasonNumber: number | null,
  ) => {
    const seasonFromInfo =
      episode.info
        ?.map((value) => value.match(/\bS(\d+)\b/i)?.[1])
        .find(Boolean) ?? undefined;
    result.push({
      id: episode.id,
      s:
        parseNumber(episode.sNum) ??
        parseNumber(episode.s) ??
        parseNumber(seasonFromInfo) ??
        seasonNumber,
      ep: parseNumber(episode.ep) ?? parseNumber(episode.epNum),
    });
  };

  type EpisodePage = {
    episodes?: Array<NetMirrorEpisode | null>;
    nextPageShow?: number;
    nextPage?: number;
    nextPageSeason?: string;
  };

  const appendPage = (page: EpisodePage) => {
    for (const episode of page.episodes ?? []) {
      if (episode) add(episode, fallbackSeason);
    }
  };

  // post.php returns whichever season the upstream site currently marks as
  // selected. For a Stremio request, the requested season is authoritative,
  // so fetch that season directly when it differs from the upstream default.
  let firstPage: EpisodePage = {
    episodes: postData.episodes,
    nextPageShow: postData.nextPageShow,
    nextPageSeason: postData.nextPageSeason,
  };
  const postSeasonMatchesRequest =
    targetSeasonIndex >= 0 && targetSeasonIndex === selectedSeasonIndex;

  if (targetSeasonId && !postSeasonMatchesRequest) {
    try {
      const response = await fetch(
        `${api}/newtv/episodes.php?id=${encodeURIComponent(targetSeasonId)}&page=1`,
        {
          headers: newTvHeaders(config.ott),
          signal: AbortSignal.timeout(15_000),
        },
      );
      firstPage = (await response.json()) as EpisodePage;
    } catch {
      // Keep the episodes embedded in post.php as a fallback.
    }
  }
  appendPage(firstPage);

  let nextPage = firstPage.nextPage ?? 2;
  let hasNextPage = firstPage.nextPageShow === 1;
  while (hasNextPage && targetSeasonId && nextPage <= 10) {
    try {
      const response = await fetch(
        `${api}/newtv/episodes.php?id=${encodeURIComponent(targetSeasonId)}&page=${nextPage}`,
        { headers: newTvHeaders(config.ott), signal: AbortSignal.timeout(15_000) },
      );
      const data = (await response.json()) as EpisodePage;
      appendPage(data);
      hasNextPage = data.nextPageShow === 1;
      nextPage = data.nextPage ?? nextPage + 1;
    } catch {
      break;
    }
  }

  return result;
}

async function fetchPlatform(
  platform: Platform,
  title: string,
  type: "movie" | "series",
  season: number | null,
  episode: number | null,
): Promise<NetMirrorStream[]> {
  try {
    const config = PLATFORM_MAP[platform];
    const api = await resolveNewTvApi();
    const searchResponse = await fetch(
      `${api}/newtv/search.php?s=${encodeURIComponent(title)}`,
      {
        headers: newTvHeaders(config.ott),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const searchData = (await searchResponse.json()) as {
      searchResult?: Array<{ id: string }>;
    };
    const first = searchData.searchResult?.[0];
    if (!first?.id) return [];

    const postResponse = await fetch(
      `${api}/newtv/post.php?id=${encodeURIComponent(first.id)}`,
      {
        headers: newTvHeaders(config.ott, { Lastep: "", Usertoken: "" }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const postData = (await postResponse.json()) as {
      type?: string;
      main_id?: string;
      episodes?: Array<{
        id: string;
        ep?: string;
        epNum?: string;
        sNum?: string;
      s?: string;
      info?: string[];
      } | null>;
      season?: NetMirrorSeason[];
      nextPageSeason?: string;
      nextPageShow?: number;
    };

    let targetId = first.id;
    if (type === "series") {
      const episodes = await getEpisodes(api, first.id, postData, config, season);
      const target = episodes.find((item) => item.s === season && item.ep === episode);
      if (!target) return [];
      targetId = target.id;
    } else if (
      postData.type === "t" ||
      (postData.episodes ?? []).filter(Boolean).length > 0
    ) {
      return [];
    } else {
      targetId = postData.main_id ?? first.id;
    }

    const playerResponse = await fetch(
      `${api}/newtv/player.php?id=${encodeURIComponent(targetId)}`,
      {
        headers: newTvHeaders(config.ott, { Usertoken: "" }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const player = (await playerResponse.json()) as {
      status?: string;
      video_link?: string;
      referer?: string;
    };
    // The current NewTV player API returns `otp` for a usable one-time
    // playback URL. Older responses used `ok`; rejecting anything except
    // `ok` silently removed every NetMirror stream.
    const playerStatus = (player.status ?? "").toLowerCase();
    if (!player.video_link || !["ok", "otp"].includes(playerStatus)) return [];
    return [
      {
        name: `NetMirror | ${platform === "primevideo" ? "Prime Video" : platform[0]!.toUpperCase() + platform.slice(1)}`,
        title: `${title}\nAuto`,
        url: player.video_link,
        behaviorHints: {
          notWebReady: true,
          headers: {
            Referer: player.referer ?? api,
            "User-Agent": nextUA(),
          },
        },
      },
    ];
  } catch (error) {
    logger.debug({ err: error, platform, title }, "NetMirror: platform failed");
    return [];
  }
}

function hdOnly(streams: NetMirrorStream[], forceHd: boolean): NetMirrorStream[] {
  if (!forceHd) return streams;
  const hd = streams.filter((stream) => {
    const match = stream.title.match(/(\d+)p/i);
    return !match || Number(match[1]) >= 720;
  });
  return hd.length ? hd : streams;
}

export async function getStreams(
  tmdbId: number,
  type: "movie" | "series",
  title: string,
  season: number | null,
  episode: number | null,
  config: NetMirrorConfig = {},
): Promise<NetMirrorStream[]> {
  const key = `${tmdbId}:${type}:${season ?? 0}:${episode ?? 0}`;
  const cached = streamCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return hdOnly(cached.streams, config.forceHd ?? true);
  }
  const running = inflight.get(key);
  if (running) return running;

  const platforms: Platform[] =
    config.preferredPlatform && config.preferredPlatform !== "all"
      ? [
          config.preferredPlatform,
          ...PLATFORM_ORDER.filter((platform) => platform !== config.preferredPlatform),
        ]
      : [...PLATFORM_ORDER];

  const request = (async () => {
    const direct = platforms.includes("netflix")
      ? await fetchNetflix(tmdbId, type, title, season, episode)
      : [];
    const fallback = await Promise.all(
      platforms
        .filter((platform) => platform !== "netflix" || direct.length === 0)
        .map((platform) => fetchPlatform(platform, title, type, season, episode)),
    );
    const streams = hdOnly([...direct, ...fallback.flat()], config.forceHd ?? true);
    streamCache.set(key, {
      streams,
      expiresAt: Date.now() + STREAM_CACHE_TTL,
    });
    logger.info({ tmdbId, type, season, episode, count: streams.length }, "NetMirror: streams ready");
    return streams;
  })().finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}