import type { NetMirrorStream } from "./netmirror.js";

/**
 * Converts the fixed NetMirror response into the addon's rich stream format.
 * Headers are translated to Stremio's proxyHeaders contract so CDN referers
 * and user agents are actually applied by compatible clients.
 */
export function formatNetMirrorStreams(
  streams: NetMirrorStream[],
  contentName: string,
  type: "movie" | "series",
  season: number,
  episode: number,
): Record<string, unknown>[] {
  return streams
    .filter((stream) => Boolean(stream.url))
    .map((stream) => {
      const rawQuality =
        stream.title.match(/\b(2160p|4K|1080p|720p|480p|360p|SD|Auto)\b/i)?.[1] ??
        "Auto";
      const platform = stream.name.replace(/^NetMirror\s*\|\s*/i, "").trim();
      const subtitles = (stream.subtitles ?? []).map((subtitle) => ({
        id: subtitle.id,
        url: subtitle.url,
        lang: subtitle.lang,
      }));
      const headers = stream.behaviorHints?.headers;
      const titleLines = [
        `🎬 ${type === "series" ? "Series" : "Movie"}: ${contentName}`,
        ...(type === "series"
          ? [`📺 Episode: S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`]
          : []),
        `🖥️ Platform: ${platform || "Streaming"}`,
        `🎥 Quality: ${rawQuality.toUpperCase()}`,
        "⚡ By NetMirror",
      ];
      return {
        name: "NetMirror",
        title: titleLines.join("\n"),
        url: stream.url,
        ...(subtitles.length ? { subtitles } : {}),
        behaviorHints: {
          notWebReady: stream.behaviorHints?.notWebReady ?? true,
          ...(headers ? { proxyHeaders: { request: headers } } : {}),
        },
      };
    });
}