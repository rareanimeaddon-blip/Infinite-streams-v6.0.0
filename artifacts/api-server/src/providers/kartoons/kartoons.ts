import axios from "axios";
import { logger } from "../../lib/logger.js";
import { findBestMatch, type MatchCandidate } from "../../utils/match.js";

const DEFAULT_KARTOONS_BASE = "https://api.kartoons.me/api/stremio";
const DEFAULT_KARTOONS_TOKEN = "DNU1ZBzyTpwPldcjg09_RBKp5KgrQaMv0tdqDr9SX48";

const BASE_URL = process.env.KARTOONS_BASE || DEFAULT_KARTOONS_BASE;
const TOKEN = process.env.KARTOONS_TOKEN || DEFAULT_KARTOONS_TOKEN;

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    Accept: "application/json",
  },
});

export interface KartoonsMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  genres?: string[];
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
}

export interface KartoonsItem {
  id: string;
  title: string;
  type: "movie" | "series";
  poster?: string;
  year?: number;
  category?: string;
}

export interface KartoonsStream {
  name: string;
  title: string;
  url: string;
  subtitles?: { id: string; lang: string; url: string }[];
  behaviorHints?: Record<string, unknown>;
}

interface EpisodeVideo {
  id: string;
  season: number;
  episode: number;
  title?: string;
}

// In-memory cache
const _cache = new Map<string, { data: unknown; expiresAt: number }>();

function getCache<T>(key: string): T | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlSeconds: number): void {
  _cache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function addonUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${BASE_URL}${path}${sep}token=${TOKEN}`;
}

async function addonGet<T>(path: string): Promise<T | null> {
  try {
    const res = await http.get<T>(addonUrl(path));
    return res.data;
  } catch (err) {
    logger.debug({ err, path }, "kartoons addon request failed");
    return null;
  }
}

export async function getFullCatalog(type: "movie" | "series"): Promise<KartoonsMeta[]> {
  const catalogId = type === "movie" ? "kartoons_movies" : "kartoons_shows";
  const cacheKey = `catalog:full:${type}`;
  const cached = getCache<KartoonsMeta[]>(cacheKey);
  if (cached) return cached;

  const data = await addonGet<{ metas?: KartoonsMeta[] }>(`/catalog/${type}/${catalogId}.json`);
  const metas = data?.metas ?? [];
  setCache(cacheKey, metas, 3600);
  return metas;
}

export async function searchCatalog(type: "movie" | "series", query: string): Promise<KartoonsMeta[]> {
  const catalogId = type === "movie" ? "kartoons_movies" : "kartoons_shows";
  const cacheKey = `catalog:search:${type}:${query.toLowerCase().trim()}`;
  const cached = getCache<KartoonsMeta[]>(cacheKey);
  if (cached) return cached;

  const cleanQuery = query.replace(/\[.*?\]|\(.*?\)/g, "").trim();
  const searchQueries = [
    cleanQuery,
    cleanQuery.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim(),
  ];
  if (cleanQuery.includes(":")) {
    searchQueries.push(cleanQuery.split(":")[0].trim());
  }

  let metas: KartoonsMeta[] = [];

  for (const q of searchQueries) {
    if (!q || q.length < 2) continue;
    const data = await addonGet<{ metas?: KartoonsMeta[] }>(
      `/catalog/${type}/${catalogId}/search=${encodeURIComponent(q)}.json`
    );
    if (data?.metas && data.metas.length > 0) {
      metas = data.metas;
      break;
    }
  }

  if (!metas.length) {
    const full = await getFullCatalog(type);
    metas = full;
  }

  setCache(cacheKey, metas, 1800);
  return metas;
}

/**
 * Compatibility adapter for the aggregator's catalog contract.
 *
 * The uploaded add-on returns Stremio metadata directly, while the existing
 * aggregator expects normalized catalog items and adds the `kartoons:` prefix
 * itself. Keep that boundary here so native stream IDs remain stable.
 */
export async function getKartoonsCatalog(
  type: "movie" | "series",
  _skip = 0,
  category?: "Anime" | "Cartoon",
): Promise<KartoonsItem[]> {
  const metas = await getFullCatalog(type);
  const categoryFiltered = category
    ? metas.filter((meta) =>
        meta.genres?.some((genre) => genre.toLowerCase() === category.toLowerCase()),
      )
    : metas;
  // The add-on's current genre values are broad labels such as "Animation"
  // and "Kids", not the legacy Anime/Cartoon catalog labels. If the requested
  // legacy filter has no exact matches, keep the catalog usable instead of
  // returning an empty page.
  const filtered = category && categoryFiltered.length === 0 ? metas : categoryFiltered;

  return filtered.slice(_skip, _skip + 30).map((meta) => ({
    id: meta.id.replace(/^kartoons:/, ""),
    title: meta.name,
    type,
    poster: meta.poster,
    year: meta.releaseInfo ? Number(meta.releaseInfo.match(/\b(19\d{2}|20\d{2})\b/)?.[1]) || undefined : undefined,
    category: meta.genres?.[0],
  }));
}

export async function resolveMeta(
  type: "movie" | "series",
  id: string
): Promise<{ title: string; year?: number } | null> {
  const cleanId = id.split(":")[0];

  // If IMDb ID (tt...) query Cinemeta
  if (cleanId.startsWith("tt")) {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${cleanId}.json`, {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const json = (await res.json()) as any;
        const meta = json?.meta;
        if (meta?.name) {
          const year = meta.year ? parseInt(String(meta.year), 10) : undefined;
          return { title: meta.name, year };
        }
      }
    } catch {}
  }

  // If TMDB ID (tmdb:123 or numeric) query TMDB
  if (cleanId.startsWith("tmdb:") || /^\d+$/.test(cleanId)) {
    const tmdbNum = cleanId.replace("tmdb:", "");
    try {
      const tmdbType = type === "series" ? "tv" : "movie";
      const res = await fetch(
        `https://api.themoviedb.org/3/${tmdbType}/${tmdbNum}?api_key=84e15019c49021a4e58e897959964f77`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        const title = data.title || data.name;
        const date = data.release_date || data.first_air_date;
        const year = date ? parseInt(date.substring(0, 4), 10) : undefined;
        if (title) return { title, year };
      }
    } catch {}
  }

  return null;
}

export async function matchItem(
  title: string,
  type: "movie" | "series",
  year?: number
): Promise<KartoonsMeta | null> {
  const candidatesRaw = await searchCatalog(type, title);
  if (!candidatesRaw.length) return null;

  const candidates: MatchCandidate<KartoonsMeta>[] = candidatesRaw.map((item) => {
    let itemYear: number | undefined;
    if (item.releaseInfo) {
      const match = item.releaseInfo.match(/\b(19\d\d|20\d\d)\b/);
      if (match) itemYear = parseInt(match[1], 10);
    }
    return {
      title: item.name,
      year: itemYear,
      type,
      raw: item,
    };
  });

  const { best } = findBestMatch(
    { title, year, type },
    candidates,
    { provider: "Kartoons", query: title },
  );
  return best?.raw ?? null;
}

export async function getEpisodeId(
  showId: string,
  season: number,
  episode: number
): Promise<string | null> {
  const formattedId = showId.startsWith("kartoons:") ? showId : `kartoons:${showId}`;
  const cacheKey = `meta:series:${formattedId}`;
  let videos = getCache<EpisodeVideo[]>(cacheKey);

  if (!videos) {
    const data = await addonGet<{ meta?: { videos?: EpisodeVideo[] } }>(
      `/meta/series/${formattedId}.json`
    );
    videos = data?.meta?.videos ?? [];
    setCache(cacheKey, videos, 3600);
  }

  // 1. Exact match
  const exact = videos.find((v) => v.season === season && v.episode === episode);
  if (exact) return exact.id;

  // 2. Relative index inside season
  const seasonEps = videos
    .filter((v) => v.season === season)
    .sort((a, b) => a.episode - b.episode);
  const byIndex = seasonEps[episode - 1];
  if (byIndex) return byIndex.id;

  // 3. Fallback across all episodes
  const sorted = [...videos].sort((a, b) => a.episode - b.episode);
  const fallback = sorted[episode - 1];
  return fallback ? fallback.id : null;
}

export async function getStreams(
  kartoonsId: string,
  type: "movie" | "series"
): Promise<KartoonsStream[]> {
  const formattedId = kartoonsId.startsWith("kartoons:") ? kartoonsId : `kartoons:${kartoonsId}`;
  const cacheKey = `streams:${formattedId}`;
  const cached = getCache<KartoonsStream[]>(cacheKey);
  if (cached) return cached;

  const data = await addonGet<{ streams?: KartoonsStream[] }>(
    `/stream/${type}/${formattedId}.json`
  );
  const streams = data?.streams ?? [];
  setCache(cacheKey, streams, 1800);
  return streams;
}
