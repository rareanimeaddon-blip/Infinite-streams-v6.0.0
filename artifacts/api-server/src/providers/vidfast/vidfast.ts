/**
 * VidFast provider — in-process live stream resolver.
 * Standalone module.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

export const VIDFAST_BASE = process.env["VIDFAST_BASE"] ?? "https://vidfast.pro";
const PLAYER_CSRF_TOKEN = "0qv1jDQw6mHsiQm7fDjrWm1VNq9sqm2a";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Referer: `${VIDFAST_BASE}/`,
  "X-Requested-With": "XMLHttpRequest",
};

export interface SubTrack {
  file?: string;
  kind?: string;
  label?: string;
  language?: string;
}

export interface VidFastRawStream {
  server: string;
  description: string;
  url: string;
  quality: string;
  type: "m3u8" | "video";
  headers: Record<string, string>;
  tracks: SubTrack[];
}

interface ServerEntry {
  name?: string;
  description?: string;
  data?: string;
}

interface StreamDecryptedResult {
  url?: string;
  file?: string;
  title?: string;
  tracks?: SubTrack[];
  "4kAvailable"?: boolean;
  mp4?: boolean;
}

let enginePromise: Promise<VidFastEngine> | null = null;

interface VidFastEngine {
  sandbox: any;
  cryptoModule: any;
  playerBuffer: any;
  loadServers: (context: any) => Promise<void>;
  decryptPayload: (context: any) => Promise<void>;
  encodeToken: (token: any) => any;
}

const reactStub: any = new Proxy(function ReactStub() {}, {
  get: (_, prop) => {
    if (prop === "__esModule") return true;
    if (prop === "default") return reactStub;
    if (prop === "useState") return (init: any) => [init, () => {}];
    if (prop === "useEffect") return () => {};
    if (prop === "useRef") return (init: any) => ({ current: init });
    if (prop === "useCallback") return (fn: any) => fn;
    if (prop === "useMemo") return (fn: any) => (typeof fn === "function" ? fn() : fn);
    if (prop === "useLayoutEffect") return () => {};
    if (prop === "Fragment") return "Fragment";
    if (prop === "createElement") return () => ({});
    if (prop === "jsx") return () => ({});
    if (prop === "jsxs") return () => ({});
    if (prop === "forwardRef") return (fn: any) => fn;
    return () => ({});
  },
});

function createModuleStubs(win: any) {
  return {
    5155: reactStub,
    8288: {
      useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
      usePathname: () => new URL(win.location.href).pathname,
    },
    63: reactStub,
    2115: reactStub,
    8613: {},
    6497: {},
    4352: {},
    3396: {},
    6368: {},
    5216: {},
    153: { hb: () => ({}) },
    2421: { f: async () => ({ cues: [] }) },
    1475: { detect: () => ({ encoding: "utf-8" }) },
  };
}

function patchLiveChunk(source: string): string {
  return source
    .replace(/=o\(7358\)/g, "=void 0")
    .replace(/o\(7358\);/g, "void 0;")
    .replace("if(!i3())return!1", "if(!1)return!1")
    .replace("if(!i7())return", "if(!1)return")
    .replace(
      /sd\.from\("xZ\/aW~D6:U0_\]EVA"\);/g,
      "globalThis.__playerEncode=sb;sd.from(\"xZ/aW~D6:U0_]EVA\");",
    )
    .replace(
      /sy\._0x5d0ad3\s*=\s*s\$/g,
      "sy._0x5d0ad3=s$,globalThis.__playerDecrypt=s$",
    )
    .replace(
      /sy\._0x1942f5\s*=\s*sj/g,
      "sy._0x1942f5=sj,globalThis.__playerLoadServers=sj",
    );
}

function getChunkDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDir, "chunks"),
    path.resolve(currentDir, "../chunks"),
    path.resolve(process.cwd(), "dist/chunks"),
    path.resolve(process.cwd(), "src/providers/vidfast/chunks"),
    path.resolve(process.cwd(), "src/chunks"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

function initVidFastEngine(): Promise<VidFastEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const chunkDir = getChunkDir();
      const win: any = new Window({ url: `${VIDFAST_BASE}/`, width: 1920, height: 1080 });

      Object.assign(win, {
        webpackChunk_N_E: [],
        chrome: { runtime: {}, app: {}, csi: () => ({}) },
        devicePixelRatio: 2,
        isSecureContext: true,
        indexedDB: null,
        queueMicrotask,
        structuredClone: globalThis.structuredClone,
        crypto: globalThis.crypto,
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        AbortSignal,
        AbortController,
        MediaSource: class {},
        MutationObserver: class {
          observe() {}
          disconnect() {}
        },
        Worker: class {
          postMessage() {}
          terminate() {}
          addEventListener() {}
        },
        MessageChannel: class {
          port1 = { postMessage: () => {}, start: () => {}, addEventListener: () => {} };
          port2 = { postMessage: () => {}, start: () => {}, addEventListener: () => {} };
        },
        BroadcastChannel: class {
          postMessage() {}
          close() {}
          addEventListener() {}
        },
        Blob: class {},
        WebSocket: class {
          send() {}
          close() {}
          addEventListener() {}
        },
        XMLHttpRequest: class {
          open() {}
          send() {}
          setRequestHeader() {}
          addEventListener() {}
        },
        requestIdleCallback: (fn: any) => setTimeout(fn, 1),
        cancelIdleCallback: clearTimeout,
      });

      Object.defineProperties(win.navigator, {
        userAgent: { value: USER_AGENT, configurable: true },
        platform: { value: "MacIntel", configurable: true },
        vendor: { value: "Google Inc.", configurable: true },
        webdriver: { value: false, configurable: true },
        maxTouchPoints: { value: 0, configurable: true },
        language: { value: "en-US", configurable: true },
        languages: { value: ["en-US", "en"], configurable: true },
        hardwareConcurrency: { value: 8, configurable: true },
        deviceMemory: { value: 8, configurable: true },
        plugins: { value: { length: 5 }, configurable: true },
        storage: { value: { estimate: async () => ({ quota: 2147483648, usage: 0 }) }, configurable: true },
      });

      win.console = console;
      win.self = win;
      win.globalThis = win;
      vm.createContext(win);

      const modules: Record<string, any> = {};
      const moduleCache: Record<string, any> = {};

      const defineExports = (exports: any, map: any) => {
        for (const [key, value] of Object.entries(map)) {
          Object.defineProperty(exports, key, {
            enumerable: true,
            get: typeof value === "function" ? (value as any) : () => value,
          });
        }
      };

      const webpackRequire = (id: string) => {
        if (moduleCache[id]) return moduleCache[id].exports;
        if (!modules[id]) throw new Error(`missing module ${id}`);
        const mod = { exports: {} };
        moduleCache[id] = mod;
        const req = Object.assign((rid: string) => webpackRequire(rid), {
          d: defineExports,
          bind: (target: any, ...args: any[]) => target.bind(...args),
          g: win,
        });
        modules[id](mod, mod.exports, req);
        return mod.exports;
      };

      const loadChunk = (filename: string, transform?: (s: string) => string) => {
        let code = fs.readFileSync(path.join(chunkDir, filename), "utf8");
        if (transform) code = transform(code);
        const queue: any[] = [];
        win.webpackChunk_N_E = queue;
        vm.runInContext(code, win, { filename, timeout: 120000 });
        if (queue.length) Object.assign(modules, queue.shift()[1]);
      };

      modules["5376"] = (mod: any) => {
        mod.exports = { Buffer };
      };
      modules["7358"] = (mod: any) => {
        mod.exports = { env: {}, versions: { chrome: "122.0.0.0" }, browser: true };
      };
      modules["1590"] = (mod: any) => {
        mod.exports = vm;
      };

      loadChunk("chunk-213.js");
      loadChunk("live-aaea2bcf.js");
      for (const [id, exp] of Object.entries(createModuleStubs(win))) {
        modules[id] = (mod: any, exports: any, req: any) => {
          mod.exports = exp;
          if (req?.d) req.d(exports, { default: () => exp, __esModule: () => true });
        };
      }
      loadChunk("live-365.js", patchLiveChunk);

      webpackRequire("9987");
      const cryptoModule = webpackRequire("3018");
      const playerBuffer = cryptoModule.randomBytes(1).constructor;

      return {
        sandbox: win,
        cryptoModule,
        playerBuffer,
        loadServers: win.__playerLoadServers,
        decryptPayload: win.__playerDecrypt,
        encodeToken: win.__playerEncode,
      };
    })();
  }
  return enginePromise;
}

function mergeHeaders(referer: string, initHeaders?: any, cookies?: Map<string, string>) {
  const headers = new Headers(initHeaders);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  headers.set("referer", referer);
  if (cookies?.size) {
    const cookieHeader = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookieHeader) headers.set("cookie", cookieHeader);
  }
  return headers;
}

function storeCookies(response: Response, cookies: Map<string, string>) {
  const header = response.headers.get("set-cookie");
  if (!header) return;
  for (const part of header.split(/,(?=\s*[^;,]+=[^;,]+)/)) {
    const segment = part.split(";")[0].trim();
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    cookies.set(segment.slice(0, eq), segment.slice(eq + 1));
  }
}

function extractPlayerProps(html: string): Record<string, any> {
  const tokenMatch = html.match(/\\"en\\":\\"([^\\"]+)\\"/);
  if (!tokenMatch?.[0]) throw new Error("vidfast: session token not found in page payload");
  const tokenStart = html.indexOf(tokenMatch[0]);
  const chunk = html.slice(tokenStart, tokenStart + 800);
  const endIdx = chunk.indexOf("}");
  const objStr = "{" + chunk.slice(0, endIdx + 1).replace(/\\"/g, '"').replace(/"\$undefined"/g, "null");
  return JSON.parse(objStr);
}

async function variants(
  masterUrl: string,
  headers: Record<string, string>,
): Promise<Array<{ quality: string; url: string }>> {
  try {
    const res = await fetch(masterUrl, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const body = await res.text();
    const base = masterUrl.slice(0, masterUrl.lastIndexOf("/") + 1);
    const out: Array<{ quality: string; url: string }> = [];
    const re = /#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n([^\n]+)/g;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body)) !== null) {
      const height = parseInt(hit[2]!, 10);
      if (height < 720) continue;
      let url = hit[3]!.trim();
      if (!url.startsWith("http")) {
        url = url.startsWith("/") ? new URL(masterUrl).origin + url : base + url;
      }
      out.push({ quality: `${height}p`, url });
    }
    return out;
  } catch {
    return [];
  }
}

export async function getVidfastRawStreams(
  tmdbId: string | number,
  type: "movie" | "series",
  season?: number,
  episode?: number,
): Promise<VidFastRawStream[]> {
  const engine = await initVidFastEngine();

  const pagePath =
    type === "series"
      ? `/tv/${tmdbId}/${season ?? 1}/${episode ?? 1}/`
      : `/movie/${tmdbId}/`;

  const pageUrl = `${VIDFAST_BASE}${pagePath}`;
  const cookies = new Map<string, string>();

  const pageRes = await fetch(pageUrl, {
    headers: { "User-Agent": USER_AGENT, Referer: `${VIDFAST_BASE}/` },
    signal: AbortSignal.timeout(15000),
  });

  if (!pageRes.ok) {
    throw new Error(`vidfast page returned status ${pageRes.status}`);
  }

  storeCookies(pageRes, cookies);
  const html = await pageRes.text();
  const props = extractPlayerProps(html);
  const targetOrigin = `https://${props.host || "vidfast.vc"}`;

  let apiBasePath = "";
  const playerFetch = async (input: any, init: any = {}) => {
    let reqUrl = String(input);
    if (!reqUrl.startsWith("http")) reqUrl = `${targetOrigin}${reqUrl}`;
    const headers = mergeHeaders(pageUrl, init.headers, cookies);
    headers.set("origin", targetOrigin);
    headers.set("accept", "*/*");
    headers.set("x-csrf-token", PLAYER_CSRF_TOKEN);
    headers.set("x-requested-with", "XMLHttpRequest");

    if (init.method === "POST" && reqUrl.includes("/u/")) {
      const match = reqUrl.match(/(\/1000061568286943\/u\/[^\/]+\/[^\/]+\/[^\/]+\/[^\/]+)/);
      if (match) apiBasePath = match[1];
    }
    const response = await fetch(reqUrl, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(15000) });
    storeCookies(response, cookies);
    return response;
  };

  const servers: ServerEntry[][] = [];
  const playerContext: any = {
    crypto: engine.cryptoModule,
    encode: engine.encodeToken,
    en: props.en,
    server: null,
    setServers: (list: any) => {
      const previous = servers.at(-1);
      const rows = typeof list === "function" ? list(previous ?? []) : list;
      servers.push(structuredClone(rows));
    },
    setState: () => {},
    setFavServer: () => {},
    window: engine.sandbox,
    document: engine.sandbox.document,
    navigator: engine.sandbox.navigator,
    localStorage: engine.sandbox.localStorage,
    console,
    JSON,
    Math,
    Date,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Symbol,
    Function,
    screen: engine.sandbox.screen,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    NaN,
    Infinity,
    undefined,
    Promise,
    Proxy,
    Reflect,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt,
    fetch: async (input: any, init: any = {}) => playerFetch(input, init),
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortSignal,
    AbortController,
    Buffer: engine.playerBuffer,
    atob: engine.sandbox.atob,
    btoa: engine.sandbox.btoa,
    Worker: engine.sandbox.Worker,
    MessageChannel: engine.sandbox.MessageChannel,
    ...props,
    id: props.id,
    host: props.host,
  };

  engine.sandbox.fetch = playerContext.fetch;
  for (const key of ["crypto", "encode", "en", "server", "setServers", "setState", "setFavServer", "fetch"]) {
    engine.sandbox[key] = playerContext[key];
  }
  engine.sandbox.location.href = pageUrl;

  await engine.loadServers(playerContext);
  const activeServers = servers.at(-1) || [];
  if (!activeServers.length) {
    return [];
  }

  const streamSegment = "0ZdfJD3jV5Q";
  const requestHeadersForStream: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: `${VIDFAST_BASE}/`,
    Origin: VIDFAST_BASE,
  };

  const resolveServerStream = async (s: ServerEntry): Promise<VidFastRawStream[]> => {
    if (!s.data) return [];
    try {
      const streamPostUrl = `${targetOrigin}${apiBasePath}/${streamSegment}/${s.data}`;
      const resp = await playerFetch(streamPostUrl, { method: "POST", body: "" });
      if (!resp.ok) return [];

      const respText = await resp.text();
      if (!respText || !respText.trim()) return [];

      const decrypted: StreamDecryptedResult[] = [];
      await engine.decryptPayload({
        ...playerContext,
        server: s,
        dr: decrypted,
        rs: respText,
      });

      const primary = decrypted[0];
      const streamUrl = primary?.url || primary?.file;
      if (!streamUrl) return [];

      const name = s.name ?? "VidFast";
      const description = s.description ?? "";
      const is4k = primary?.["4kAvailable"] === true || /4k/i.test(description);
      const fallbackQuality = is4k ? "2160p" : "1080p";
      const isHls = streamUrl.includes(".m3u8");
      const tracks = Array.isArray(primary?.tracks) ? primary.tracks : [];

      const base: Omit<VidFastRawStream, "url" | "quality" | "type"> = {
        server: name,
        description,
        headers: requestHeadersForStream,
        tracks,
      };

      const out: VidFastRawStream[] = [
        { ...base, url: streamUrl, quality: isHls ? "Auto" : fallbackQuality, type: isHls ? "m3u8" : "video" },
      ];

      if (isHls) {
        const qualityVariants = await variants(streamUrl, requestHeadersForStream);
        for (const v of qualityVariants) {
          out.push({ ...base, url: v.url, quality: v.quality, type: "m3u8" });
        }
      }

      return out;
    } catch (err) {
      return [];
    }
  };

  const allStreamPromises = activeServers.map((s) => resolveServerStream(s));
  const settled = await Promise.all(allStreamPromises);
  return settled.flat();
}
