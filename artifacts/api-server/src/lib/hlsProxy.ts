import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { logger } from "./logger.js";

const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const HLS_PROXY_PREFIX = "/proxy/hls/";
export const SEGMENT_PROXY_PREFIX = "/proxy/seg/";

function encodeTarget(target: string, referer: string): string {
  return Buffer.from(JSON.stringify({ u: target, r: referer }), "utf8").toString("base64url");
}

function decodeTarget(token: string): { target: string; referer: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      u?: string;
      r?: string;
    };
    if (typeof parsed.u !== "string") return null;
    const url = new URL(parsed.u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return {
      target: url.toString(),
      referer: typeof parsed.r === "string" ? parsed.r : "",
    };
  } catch {
    return null;
  }
}

const PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";

export const PROXIED_SOURCE_HOSTNAMES = new Set(["vip.1x2.space"]);

export function shouldProxySource(sourceFile: string): boolean {
  if (process.env.PROXY_ALL === "1") return true;
  try {
    return PROXIED_SOURCE_HOSTNAMES.has(new URL(sourceFile).hostname);
  } catch {
    return false;
  }
}

export function publicBaseUrl(request: IncomingMessage): string {
  const headers = request.headers;
  const forwardedProto = firstHeaderValue(headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(headers["x-forwarded-host"]);
  const host = forwardedHost ?? firstHeaderValue(headers.host) ?? "127.0.0.1";
  const proto =
    forwardedProto ??
    (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.split(",")[0]!.trim();
}

function proxyUrl(baseUrl: string, prefix: string, target: string, referer: string): string {
  const extension = prefix === HLS_PROXY_PREFIX ? ".m3u8" : ".ts";
  return `${baseUrl}${prefix}${encodeTarget(target, referer)}${extension}`;
}

export function buildPlaylistProxyUrl(baseUrl: string, target: string, referer: string): string {
  return proxyUrl(baseUrl, HLS_PROXY_PREFIX, target, referer);
}

function isPlaylistUri(absoluteUrl: string): boolean {
  const pathname = safePathname(absoluteUrl).toLowerCase();
  return pathname.endsWith(".m3u8") || pathname.endsWith(".m3u");
}

function safePathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

function rewritePlaylist(
  body: string,
  playlistUrl: string,
  baseUrl: string,
  referer: string,
): string {
  const rewriteTarget = (rawUri: string): string => {
    const trimmed = rawUri.trim();
    if (trimmed.length === 0) return rawUri;

    let absolute: string;
    try {
      absolute = new URL(trimmed, playlistUrl).toString();
    } catch {
      return rawUri;
    }

    const prefix = isPlaylistUri(absolute) ? HLS_PROXY_PREFIX : SEGMENT_PROXY_PREFIX;
    return proxyUrl(baseUrl, prefix, absolute, referer);
  };

  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(
          /URI="([^"]*)"/g,
          (_match, uri: string) => `URI="${rewriteTarget(uri)}"`,
        );
      }

      return rewriteTarget(trimmed);
    })
    .join("\n");
}

function upstreamHeaders(
  request: IncomingMessage,
  referer: string,
  forwardRange: boolean,
): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent": PROXY_UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (referer) {
    headers.Referer = referer;
    try {
      headers.Origin = new URL(referer).origin;
    } catch {
      // Invalid referers do not need an Origin header.
    }
  }

  if (forwardRange && typeof request.headers.range === "string") {
    headers.Range = request.headers.range;
  }

  return headers;
}

function parseProxyRequest(
  request: IncomingMessage,
  prefix: string,
): { target: string; referer: string } | null {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname.startsWith(prefix)) {
    const token = url.pathname.slice(prefix.length).replace(/\.(m3u8|m3u|ts)$/i, "");
    if (token.length > 0) return decodeTarget(token);
  }

  const target = url.searchParams.get("u");
  if (!target) return null;

  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { target: parsed.toString(), referer: url.searchParams.get("r") ?? "" };
  } catch {
    return null;
  }
}

export async function handlePlaylistProxy(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const parsed = parseProxyRequest(request, HLS_PROXY_PREFIX);
  if (!parsed) {
    plainText(response, 400, "Missing or invalid target URL");
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(parsed.target, {
      headers: upstreamHeaders(request, parsed.referer, false),
      redirect: "follow",
    });
  } catch (error) {
    logger.warn({ error, target: parsed.target }, "HLS proxy: playlist fetch failed");
    plainText(response, 502, "Upstream playlist unavailable");
    return;
  }

  if (!upstream.ok) {
    logger.warn(
      { target: parsed.target, status: upstream.status },
      "HLS proxy: upstream playlist error",
    );
    plainText(response, 502, `Upstream playlist error ${upstream.status}`);
    return;
  }

  const body = await upstream.text();
  const rewritten = rewritePlaylist(
    body,
    upstream.url || parsed.target,
    publicBaseUrl(request),
    parsed.referer,
  );

  response.writeHead(200, {
    "Content-Type": PLAYLIST_CONTENT_TYPE,
    "Content-Length": Buffer.byteLength(rewritten),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  response.end(rewritten);
}

export async function handleSegmentProxy(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const parsed = parseProxyRequest(request, SEGMENT_PROXY_PREFIX);
  if (!parsed) {
    plainText(response, 400, "Missing or invalid target URL");
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(parsed.target, {
      headers: upstreamHeaders(request, parsed.referer, true),
      redirect: "follow",
    });
  } catch (error) {
    logger.warn({ error, target: parsed.target }, "HLS proxy: segment fetch failed");
    plainText(response, 502, "Upstream segment unavailable");
    return;
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Accept-Ranges": upstream.headers.get("accept-ranges") ?? "bytes",
    "Cache-Control": "no-store",
  };
  const contentType = upstream.headers.get("content-type");
  headers["Content-Type"] =
    !contentType || /html|plain/i.test(contentType) ? "video/mp2t" : contentType;

  for (const header of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    if (value) headers[header] = value;
  }

  response.writeHead(upstream.status, headers);

  if (request.method === "HEAD" || !upstream.body) {
    response.end();
    return;
  }

  try {
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    stream.pipe(response);
    stream.on("error", () => response.destroy());
  } catch (error) {
    logger.warn({ error, target: parsed.target }, "HLS proxy: segment stream failed");
    response.destroy();
  }
}

function plainText(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(message);
}