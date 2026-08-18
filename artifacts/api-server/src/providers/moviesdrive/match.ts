import { logger } from "./logger.js";

export type ContentType = "movie" | "series";

export interface MatchQuery {
  title: string;
  originalTitle?: string;
  aliases?: string[];
  year?: number;
  type?: ContentType;
  season?: number;
  episode?: number;
}

export interface MatchCandidate<T = unknown> {
  title: string;
  originalTitle?: string;
  aliases?: string[];
  year?: number;
  type?: ContentType;
  season?: number;
  episode?: number;
  raw: T;
}

export interface ScoredCandidate<T = unknown> {
  candidate: MatchCandidate<T>;
  score: number;
  breakdown: Record<string, number>;
  matchedOn: string;
}

export interface FindBestMatchOptions {
  provider: string;
  threshold?: number;
  query?: string;
  quiet?: boolean;
}

export interface FindBestMatchResult<T = unknown> {
  best: MatchCandidate<T> | null;
  score: number;
  breakdown: Record<string, number>;
  matchedOn: string;
  reason: string;
  ranked: ScoredCandidate<T>[];
}

const QUALITY_TAGS =
  /\b(4k|2160p|1080p|720p|480p|360p|hd|fhd|uhd|hdr|web[-\s]?dl|webrip|web|bluray|blu-ray|brrip|bdrip|dvdrip|hdrip|hdtv|hdcam|cam|dual audio|multi audio|dual[-\s]?audio|multi[-\s]?audio|x264|x265|hevc|h264|h265|10bit|esub|esubs|msubs|amzn|nf|hin|eng|hindi|english|dubbed|dub|subbed|sub|season\s*\d+|s\d{1,2}|complete|full)\b/gi;

const STOP_WORDS = new Set(["the", "a", "an", "of", "in", "at", "to", "with", "and", "or", "for", "on"]);

function baseNormalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/([a-z])\./g, "$1")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStripQuality(s: string): string {
  const withoutQuality = s.replace(QUALITY_TAGS, " ");
  return baseNormalize(withoutQuality);
}

function tokenize(s: string): string[] {
  return baseNormalize(s).split(" ").filter(Boolean);
}

function significantTokens(s: string): string[] {
  return tokenize(s).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function bigrams(s: string): string[] {
  const clean = baseNormalize(s).replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

function diceCoefficient(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return ba.length === bb.length ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let matches = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      matches++;
      counts.set(g, c - 1);
    }
  }
  return (2 * matches) / (ba.length + bb.length);
}

interface TextScoreBreakdown {
  exact: number;
  normalized: number;
  fuzzy: number;
  wholeWord: number;
  startsWith: number;
  score: number;
}

function scoreTitleText(query: string, candidate: string): TextScoreBreakdown {
  if (!query || !candidate) {
    return { exact: 0, normalized: 0, fuzzy: 0, wholeWord: 0, startsWith: 0, score: 0 };
  }

  const exact = query.trim().toLowerCase() === candidate.trim().toLowerCase() ? 1 : 0;

  const nq = normalizeStripQuality(query);
  const nc = normalizeStripQuality(candidate);
  let normalized = nq === nc ? 1 : 0;
  if (!normalized && nq.replace(/\s+/g, "") === nc.replace(/\s+/g, "")) normalized = 0.92;

  const tokenJaccardOf = (): number => {
    const qa = new Set(significantTokens(nq));
    const ca = new Set(significantTokens(nc));
    if (qa.size === 0 || ca.size === 0) return 0;
    let intersection = 0;
    for (const t of qa) if (ca.has(t)) intersection++;
    const union = qa.size + ca.size - intersection;
    return union === 0 ? 0 : intersection / union;
  };
  const fuzzy = 0.5 * tokenJaccardOf() + 0.5 * diceCoefficient(nq, nc);

  const qSig = significantTokens(nq);
  const cSigSet = new Set(significantTokens(nc));
  const wholeWord =
    qSig.length === 0 ? 0 : qSig.filter((w) => cSigSet.has(w)).length / qSig.length;

  let startsWith = 0;
  if (nc.startsWith(nq) || nq.startsWith(nc)) startsWith = 1;
  else {
    const qFirst = nq.split(" ")[0];
    const cFirst = nc.split(" ")[0];
    if (qFirst && cFirst && qFirst === cFirst) startsWith = 0.5;
  }

  const score =
    exact * 0.35 + normalized * 0.25 + fuzzy * 0.2 + wholeWord * 0.1 + startsWith * 0.1;

  return { exact, normalized, fuzzy, wholeWord, startsWith, score: Math.min(1, score) };
}

function bestTitleScore(
  query: MatchQuery,
  candidate: MatchCandidate,
): { score: number; breakdown: TextScoreBreakdown; matchedOn: string } {
  const attempts: Array<{ label: string; text: string }> = [{ label: "title", text: candidate.title }];
  if (candidate.originalTitle) attempts.push({ label: "originalTitle", text: candidate.originalTitle });
  for (const alias of candidate.aliases ?? []) attempts.push({ label: `alias:${alias}`, text: alias });

  const queryTitles = [query.title, query.originalTitle, ...(query.aliases ?? [])].filter(
    (t): t is string => !!t,
  );

  let best: { score: number; breakdown: TextScoreBreakdown; matchedOn: string } | null = null;
  for (const q of queryTitles) {
    for (const a of attempts) {
      const breakdown = scoreTitleText(q, a.text);
      if (!best || breakdown.score > best.score) {
        best = { score: breakdown.score, breakdown, matchedOn: a.label };
      }
    }
  }
  return best ?? { score: 0, breakdown: scoreTitleText("", ""), matchedOn: "title" };
}

function scoreYear(query?: number, candidate?: number): number {
  if (!query || !candidate) return 0.5;
  const diff = Math.abs(query - candidate);
  if (diff === 0) return 1;
  if (diff === 1) return 0.6;
  if (diff === 2) return 0.3;
  return 0.05;
}

function scoreType(query?: ContentType, candidate?: ContentType): number {
  if (!query || !candidate) return 0.5;
  return query === candidate ? 1 : 0;
}

function scoreSeasonEpisode(query: MatchQuery, candidate: MatchCandidate): number {
  if (query.type !== "series") return 1;
  if (query.season == null || candidate.season == null) return 0.7;
  if (query.season !== candidate.season) return 0.15;
  if (query.episode == null || candidate.episode == null) return 1;
  return query.episode === candidate.episode ? 1 : 0.6;
}

export function scoreCandidate<T>(
  query: MatchQuery,
  candidate: MatchCandidate<T>,
): { score: number; breakdown: Record<string, number>; matchedOn: string } {
  const text = bestTitleScore(query, candidate);
  const year = scoreYear(query.year, candidate.year);
  const type = scoreType(query.type, candidate.type);
  const seasonEpisode = scoreSeasonEpisode(query, candidate);

  const score = text.score * 0.6 + year * 0.1 + type * 0.2 + seasonEpisode * 0.1;

  return {
    score: Math.min(1, Math.max(0, score)),
    matchedOn: text.matchedOn,
    breakdown: {
      textScore: round(text.score),
      exact: round(text.breakdown.exact),
      normalized: round(text.breakdown.normalized),
      fuzzy: round(text.breakdown.fuzzy),
      wholeWord: round(text.breakdown.wholeWord),
      startsWith: round(text.breakdown.startsWith),
      year: round(year),
      type: round(type),
      seasonEpisode: round(seasonEpisode),
    },
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const DEFAULT_THRESHOLD = 0.45;

export function findBestMatch<T>(
  query: MatchQuery,
  candidates: Array<MatchCandidate<T>>,
  options: FindBestMatchOptions,
): FindBestMatchResult<T> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  const ranked: ScoredCandidate<T>[] = candidates
    .map((candidate) => {
      const { score, breakdown, matchedOn } = scoreCandidate(query, candidate);
      return { candidate, score, breakdown, matchedOn };
    })
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  if (!top) {
    logger.info(`[Match:${options.provider}] no candidates returned by search for "${options.query ?? query.title}"`);
    return { best: null, score: 0, breakdown: {}, matchedOn: "", reason: "no candidates returned by search", ranked };
  }

  const passed = top.score >= threshold;
  const reason = passed
    ? `best candidate "${top.candidate.title}" scored ${round(top.score)} (>= threshold ${threshold}) via ${top.matchedOn}`
    : `best candidate "${top.candidate.title}" scored ${round(top.score)} which is below threshold ${threshold} — rejected`;

  logger.info(`[Match:${options.provider}] ${passed ? `selected "${top.candidate.title}" (score ${round(top.score)})` : "no match above threshold"}`);

  if (!passed) {
    return { best: null, score: top.score, breakdown: top.breakdown, matchedOn: top.matchedOn, reason, ranked };
  }

  return { best: top.candidate, score: top.score, breakdown: top.breakdown, matchedOn: top.matchedOn, reason, ranked };
}

export async function findBestMatchWithRetry<T>(
  query: MatchQuery,
  variantTitles: string[],
  search: (variantTitle: string) => Promise<Array<MatchCandidate<T>>>,
  options: FindBestMatchOptions,
): Promise<FindBestMatchResult<T>> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const tried = new Set<string>();
  let bestSoFar: FindBestMatchResult<T> | null = null;

  for (const variant of variantTitles) {
    const key = variant.trim().toLowerCase();
    if (!key || tried.has(key)) continue;
    tried.add(key);

    let candidates: Array<MatchCandidate<T>>;
    try {
      candidates = await search(variant);
    } catch (err) {
      continue;
    }
    if (!candidates.length) continue;

    const result = findBestMatch({ ...query, title: variant }, candidates, {
      ...options,
      query: variant,
    });

    if (!bestSoFar || result.score > bestSoFar.score) bestSoFar = result;

    if (result.best && result.score >= threshold) {
      return result;
    }
  }

  return {
    best: null,
    score: bestSoFar?.score ?? 0,
    breakdown: bestSoFar?.breakdown ?? {},
    matchedOn: bestSoFar?.matchedOn ?? "",
    reason: bestSoFar
      ? `best candidate scored ${round(bestSoFar.score)}, below threshold ${threshold}`
      : "no results found across any title variant",
    ranked: bestSoFar?.ranked ?? [],
  };
}
