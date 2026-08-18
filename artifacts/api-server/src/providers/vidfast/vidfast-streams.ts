/**
 * Formats VidFast streams for the Stremio Addon protocol.
 */

import { type VidFastRawStream, VIDFAST_BASE } from "./vidfast.js";

export interface VidFastStremioStream {
  name: string;
  title: string;
  url: string;
  behaviorHints: {
    notWebReady: boolean;
    bingeGroup: string;
    proxyHeaders: {
      request: Record<string, string>;
    };
  };
  subtitles?: Array<{
    id: string;
    url: string;
    lang: string;
  }>;
  _idVerified?: boolean;
}

export function buildVidfastStreams(rawStreams: VidFastRawStream[]): VidFastStremioStream[] {
  const seenUrls = new Set<string>();
  const out: VidFastStremioStream[] = [];

  for (const s of rawStreams) {
    if (!s.url || seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);

    const serverLabel = s.server || "VidFast";
    const qualityLabel = s.quality ? ` • ${s.quality}` : "";
    const name = `⚡ VidFast\n${serverLabel}${qualityLabel}`;

    const descPart = s.description ? ` • ${s.description}` : "";
    const hostLabel = "vidfast.vc";
    const title = `${serverLabel}${descPart}\n${hostLabel}`;

    const requestHeaders: Record<string, string> = {
      "User-Agent":
        s.headers?.["User-Agent"] ||
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: s.headers?.["Referer"] || `${VIDFAST_BASE}/`,
      Origin: s.headers?.["Origin"] || VIDFAST_BASE,
    };

    const subtitles = (s.tracks || [])
      .filter((t) => t.file)
      .map((t, idx) => ({
        id: `vidfast-sub-${idx}-${t.label || t.language || "sub"}`,
        url: t.file!,
        lang: t.label || t.language || "Unknown",
      }));

    out.push({
      name,
      title,
      url: s.url,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: `vidfast-${s.server}-${s.quality}`,
        proxyHeaders: {
          request: requestHeaders,
        },
      },
      subtitles: subtitles.length ? subtitles : undefined,
      _idVerified: true,
    });
  }

  return out;
}
