const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const SCRAPER_PATH = path.join(ROOT_DIR, "websEvent.py");
const DATA_PATH = path.join(ROOT_DIR, "jason.json");

const DEFAULT_SCRAPE_OPTIONS = Object.freeze({
  sources: "reddit",
  maxResults: 20,
  redditPages: 4,
  redditLimit: 20,
  rateLimitS: 0.25,
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let scrapeInFlight = false;

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  if (res.req && res.req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function sendJson(res, statusCode, data) {
  send(
    res,
    statusCode,
    { "content-type": "application/json; charset=utf-8" },
    JSON.stringify(data),
  );
}

function sendText(res, statusCode, text) {
  send(res, statusCode, { "content-type": "text/plain; charset=utf-8" }, text);
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  const stream = fs.createReadStream(filePath);
  stream.on("open", () => {
    res.writeHead(200, { "content-type": contentType });
    if (res.req && res.req.method === "HEAD") {
      stream.destroy();
      res.end();
      return;
    }
    stream.pipe(res);
  });
  stream.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      sendText(res, 404, "Not Found");
      return;
    }
    sendText(res, 500, "Internal Server Error");
  });
}

function resolvePublicPath(urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }

  const resolved = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (resolved === PUBLIC_DIR) {
    return path.join(PUBLIC_DIR, "index.html");
  }
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

function createEmptyPayload() {
  return {
    generated_at: new Date().toISOString(),
    result_count: 0,
    results: [],
  };
}

function parseJsonDocuments(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return [];
  }

  try {
    return [JSON.parse(raw)];
  } catch {
    const documents = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];

      if (start === -1) {
        if (/\s/.test(char)) {
          continue;
        }
        if (char === "{" || char === "[") {
          start = index;
          depth = 1;
          inString = false;
          escaped = false;
        }
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        depth += 1;
        continue;
      }

      if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          const chunk = raw.slice(start, index + 1);
          try {
            documents.push(JSON.parse(chunk));
          } catch {
            // Ignore malformed chunk and continue scanning.
          }
          start = -1;
        }
      }
    }

    return documents;
  }
}

function sanitizeResult(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata
    : {};

  return {
    text: String(item.text || ""),
    source: String(item.source || ""),
    metadata,
  };
}

function extractResultsFromDocument(document) {
  const rawResults = Array.isArray(document)
    ? document
    : Array.isArray(document && document.results)
      ? document.results
      : [];

  return rawResults.map(sanitizeResult).filter(Boolean);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function getResultKey(item) {
  const metadata = item && item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const platform = normalizeText(metadata.platform || "unknown");
  const platformId = normalizeText(metadata.id || metadata.outbound_url || metadata.title || "");
  const source = normalizeText(item && item.source);
  const text = normalizeText(item && item.text).slice(0, 200);

  if (platformId) {
    return `${platform}::${platformId}`;
  }
  if (source) {
    return `${platform}::${source}`;
  }
  return `${platform}::${text}`;
}

function dedupeResults(results) {
  const seen = new Set();
  const merged = [];

  for (const item of results.map(sanitizeResult).filter(Boolean)) {
    const key = getResultKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

async function readFileIfExists(filePath) {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function loadStoredEvents() {
  const raw = await readFileIfExists(DATA_PATH);
  const documents = parseJsonDocuments(raw);

  if (!documents.length) {
    return createEmptyPayload();
  }

  let generatedAt = "";
  const allResults = [];

  for (const document of documents) {
    if (document && typeof document === "object" && !Array.isArray(document) && document.generated_at) {
      generatedAt = String(document.generated_at);
    }
    allResults.push(...extractResultsFromDocument(document));
  }

  const results = dedupeResults(allResults);
  return {
    generated_at: generatedAt || new Date().toISOString(),
    result_count: results.length,
    results,
  };
}

async function writeStoredEvents(payload) {
  const results = dedupeResults(payload && payload.results ? payload.results : []);
  const normalizedPayload = {
    generated_at: payload && payload.generated_at ? String(payload.generated_at) : new Date().toISOString(),
    result_count: results.length,
    results,
  };

  await fs.promises.writeFile(
    DATA_PATH,
    `${JSON.stringify(normalizedPayload, null, 2)}\n`,
    "utf8",
  );

  return normalizedPayload;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function toPositiveNumber(value, fallback, { minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, numeric));
}

function buildScrapeArgs(options) {
  const sources = typeof options.sources === "string" && options.sources.trim()
    ? options.sources.trim()
    : DEFAULT_SCRAPE_OPTIONS.sources;

  const maxResults = toPositiveNumber(options.maxResults, DEFAULT_SCRAPE_OPTIONS.maxResults, {
    minimum: 1,
    maximum: 200,
  });
  const redditPages = toPositiveNumber(options.redditPages, DEFAULT_SCRAPE_OPTIONS.redditPages, {
    minimum: 1,
    maximum: 20,
  });
  const redditLimit = toPositiveNumber(options.redditLimit, DEFAULT_SCRAPE_OPTIONS.redditLimit, {
    minimum: 1,
    maximum: 100,
  });
  const rateLimitS = toPositiveNumber(options.rateLimitS, DEFAULT_SCRAPE_OPTIONS.rateLimitS, {
    minimum: 0,
    maximum: 5,
  });

  return [
    SCRAPER_PATH,
    "--output",
    "-",
    "--sources",
    sources,
    "--max-results",
    String(maxResults),
    "--reddit-pages",
    String(redditPages),
    "--reddit-limit",
    String(redditLimit),
    "--rate-limit-s",
    String(rateLimitS),
  ];
}

function execFileCapture(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: ROOT_DIR,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

async function runScraper(options = {}) {
  const args = buildScrapeArgs(options);
  const commands = ["python3", "python"];

  let lastError = null;
  for (const command of commands) {
    try {
      const { stdout, stderr } = await execFileCapture(command, args);
      const parsed = JSON.parse(String(stdout || "").trim() || "{}");
      return { payload: parsed, stderr };
    } catch (error) {
      lastError = error;
      if (error && error.code === "ENOENT") {
        continue;
      }
      break;
    }
  }

  const stderr = lastError && lastError.stderr ? String(lastError.stderr).trim() : "";
  const stdout = lastError && lastError.stdout ? String(lastError.stdout).trim() : "";
  const detail = stderr || stdout || (lastError && lastError.message) || "Unknown scraper failure.";
  throw new Error(`websEvent.py failed: ${detail}`);
}

function mergeScrapeResults(existingPayload, scrapePayload) {
  const existingResults = dedupeResults(existingPayload && existingPayload.results ? existingPayload.results : []);
  const scrapedResults = dedupeResults(extractResultsFromDocument(scrapePayload));
  const existingKeys = new Set(existingResults.map(getResultKey));
  const newResults = scrapedResults.filter((item) => !existingKeys.has(getResultKey(item)));
  const mergedResults = dedupeResults([...existingResults, ...newResults]);

  return {
    scrapedResults,
    newResults,
    mergedPayload: {
      generated_at: new Date().toISOString(),
      result_count: mergedResults.length,
      results: mergedResults,
    },
  };
}

async function handleApiRequest(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api") {
    sendJson(res, 200, { message: "🌊 Ocean API is working!" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const payload = await loadStoredEvents();
    sendJson(res, 200, payload);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/events/scrape") {
    if (scrapeInFlight) {
      sendJson(res, 409, { error: "A scrape is already in progress." });
      return true;
    }

    const body = await readJsonBody(req);
    scrapeInFlight = true;

    try {
      const existingPayload = await loadStoredEvents();
      const { payload: scrapePayload, stderr } = await runScraper(body || {});
      const { scrapedResults, newResults, mergedPayload } = mergeScrapeResults(existingPayload, scrapePayload);
      const storedPayload = await writeStoredEvents(mergedPayload);

      sendJson(res, 200, {
        generated_at: storedPayload.generated_at,
        scraped_result_count: scrapedResults.length,
        new_results_added: newResults.length,
        duplicate_results_skipped: scrapedResults.length - newResults.length,
        stored_result_count: storedPayload.result_count,
        results: scrapedResults,
        new_results: newResults,
        stderr: stderr || "",
      });
    } finally {
      scrapeInFlight = false;
    }

    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "API route not found." });
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/config.js") {
    const arcgisApiKey = process.env.ARCGIS_API_KEY || "";
    const js = `// Generated at request time. Avoid committing secrets.\nwindow.__ARCGIS_API_KEY = ${JSON.stringify(
      arcgisApiKey,
    )};\n`;
    send(
      res,
      200,
      {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
      js,
    );
    return;
  }

  if (await handleApiRequest(req, res, url)) {
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const resolved = resolvePublicPath(url.pathname);
  if (!resolved) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (!err && stat.isDirectory()) {
      serveFile(res, path.join(resolved, "index.html"));
      return;
    }

    if (!err) {
      serveFile(res, resolved);
      return;
    }

    serveFile(res, path.join(PUBLIC_DIR, "index.html"));
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    sendJson(res, 500, { error: error.message || "Internal Server Error" });
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`🌊 Server running at http://${HOST}:${PORT}`);
});
