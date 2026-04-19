const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const POSTS_JSON_PATH = process.env.POSTS_JSON_PATH || path.join(__dirname, "..", "jason.json");

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

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJson(res, statusCode, data) {
  send(res, statusCode, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(data));
}

function sendText(res, statusCode, text) {
  send(res, statusCode, { "content-type": "text/plain; charset=utf-8" }, text);
}

function sendGeoJson(res, statusCode, data) {
  send(res, statusCode, { "content-type": "application/geo+json; charset=utf-8" }, JSON.stringify(data));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  const stream = fs.createReadStream(filePath);
  stream.on("open", () => {
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
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
  // Keep requests confined to PUBLIC_DIR and prevent path traversal.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  const resolved = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (resolved === PUBLIC_DIR) return path.join(PUBLIC_DIR, "index.html");
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) return null;
  return resolved;
}

function _hash32(value) {
  const s = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function _stableJitter(seed) {
  // Deterministic jitter so points don't perfectly overlap.
  const h = _hash32(seed);
  const a = ((h & 0xffff) / 0xffff) - 0.5;
  const b = (((h >>> 16) & 0xffff) / 0xffff) - 0.5;
  return { a, b };
}

const LOCATION_COORDS = [
  // Coastal-ish anchor points for common CA place names.
  { key: "san diego", coords: [-117.1611, 32.7157] },
  { key: "los angeles", coords: [-118.2437, 34.0522] },
  { key: "orange county", coords: [-117.8311, 33.7175] },
  { key: "santa monica", coords: [-118.4912, 34.0195] },
  { key: "malibu", coords: [-118.7798, 34.0259] },
  { key: "huntington beach", coords: [-117.9988, 33.6595] },
  { key: "venice beach", coords: [-118.4731, 33.985] },
  { key: "long beach", coords: [-118.1937, 33.7701] },
  { key: "laguna beach", coords: [-117.7801, 33.5427] },
  { key: "newport beach", coords: [-117.9298, 33.6189] },
  { key: "santa cruz", coords: [-122.0308, 36.9741] },
  { key: "monterey", coords: [-121.8947, 36.6002] },
  { key: "monterey bay", coords: [-121.8947, 36.6002] },
  { key: "santa barbara", coords: [-119.6982, 34.4208] },
  { key: "ventura", coords: [-119.229, 34.2746] },
  { key: "pismo", coords: [-120.6413, 35.1428] },
  { key: "pacifica", coords: [-122.4869, 37.6138] },
  { key: "san francisco", coords: [-122.4194, 37.7749] },
  { key: "oakland", coords: [-122.2711, 37.8044] },
  { key: "san jose", coords: [-121.8863, 37.3382] },
  { key: "bay area", coords: [-122.4194, 37.7749] },
];

const SUBREDDIT_FALLBACK_COORDS = {
  california: [-119.4179, 36.7783],
  oc: [-117.8311, 33.7175],
  orangecounty: [-117.8311, 33.7175],
  sandiego: [-117.1611, 32.7157],
  losangeles: [-118.2437, 34.0522],
  bayarea: [-122.4194, 37.7749],
  sanfrancisco: [-122.4194, 37.7749],
  sf: [-122.4194, 37.7749],
  oakland: [-122.2711, 37.8044],
  sanjose: [-121.8863, 37.3382],
  santacruz: [-122.0308, 36.9741],
  montereybay: [-121.8947, 36.6002],
  santabarbara: [-119.6982, 34.4208],
  ventura: [-119.229, 34.2746],
  longbeach: [-118.1937, 33.7701],
};

function inferCoords(item) {
  const text = String(item?.text || "");
  const metadata = item?.metadata || {};
  const title = String(metadata.title || "");
  const query = String(metadata.query || "");
  const haystack = `${title}\n${text}\n${query}`.toLowerCase();

  for (const loc of LOCATION_COORDS) {
    if (loc.key && haystack.includes(loc.key)) {
      const { a, b } = _stableJitter(metadata.id || item.source || title || text);
      const jitter = 0.08;
      return [loc.coords[0] + a * jitter, loc.coords[1] + b * jitter];
    }
  }

  const subreddit = String(metadata.subreddit || "").trim().toLowerCase();
  if (subreddit && SUBREDDIT_FALLBACK_COORDS[subreddit]) {
    const base = SUBREDDIT_FALLBACK_COORDS[subreddit];
    const { a, b } = _stableJitter(metadata.id || item.source || subreddit);
    const jitter = 0.18;
    return [base[0] + a * jitter, base[1] + b * jitter];
  }

  // Fallback: center-ish on the CA coast with jitter.
  const base = [-120.5, 36.2];
  const { a, b } = _stableJitter(metadata.id || item.source || text);
  const jitter = 0.55;
  return [base[0] + a * jitter, base[1] + b * jitter];
}

function toGeoJsonFeatureCollection(raw) {
  const results = Array.isArray(raw?.results) ? raw.results : [];
  const features = results.map((item, index) => {
    const metadata = item?.metadata || {};
    const [lon, lat] = inferCoords(item);
    const title = String(metadata.title || "").trim() || `Post ${index + 1}`;
    const text = String(item?.text || "");

    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [lon, lat],
      },
      properties: {
        id: String(metadata.id || ""),
        title,
        text,
        source: String(item?.source || ""),
        platform: String(metadata.platform || ""),
        subreddit: String(metadata.subreddit || ""),
        created_iso: String(metadata.created_iso || ""),
        score: metadata.score ?? null,
        num_comments: metadata.num_comments ?? null,
        query: String(metadata.query || ""),
        generated_at: String(raw?.generated_at || ""),
      },
    };
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function toCsv(raw) {
  const results = Array.isArray(raw?.results) ? raw.results : [];
  const header = [
    "id",
    "longitude",
    "latitude",
    "title",
    "platform",
    "subreddit",
    "created_iso",
    "score",
    "num_comments",
    "query",
    "source",
    "text_snippet",
  ];

  const lines = [header.join(",")];
  results.forEach((item, index) => {
    const metadata = item?.metadata || {};
    const [lon, lat] = inferCoords(item);
    const title = String(metadata.title || "").trim() || `Post ${index + 1}`;
    const text = String(item?.text || "").replaceAll(/\s+/g, " ").trim();
    const snippet = text.length > 240 ? `${text.slice(0, 237)}…` : text;

    const row = [
      metadata.id || "",
      lon,
      lat,
      title,
      metadata.platform || "",
      metadata.subreddit || "",
      metadata.created_iso || "",
      metadata.score ?? "",
      metadata.num_comments ?? "",
      metadata.query || "",
      item?.source || "",
      snippet,
    ].map(csvEscape);

    lines.push(row.join(","));
  });

  return lines.join("\n") + "\n";
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/config.js") {
    const js = `// Deprecated: API keys are no longer injected into the client.\nwindow.__ARCGIS_API_KEY = \"\";\n`;
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

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/data/posts.geojson") {
    fs.readFile(POSTS_JSON_PATH, "utf-8", (err, text) => {
      if (err) {
        if (err.code === "ENOENT") {
          sendText(res, 404, `Not Found: ${POSTS_JSON_PATH}`);
          return;
        }
        sendText(res, 500, "Internal Server Error");
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendText(res, 500, "Failed to parse posts JSON");
        return;
      }

      const geojson = toGeoJsonFeatureCollection(parsed);
      const headers = {
        "content-type": "application/geo+json; charset=utf-8",
        "cache-control": "no-store",
      };
      if (req.method === "HEAD") {
        send(res, 200, headers, "");
        return;
      }
      send(res, 200, headers, JSON.stringify(geojson));
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/data/posts.csv") {
    fs.readFile(POSTS_JSON_PATH, "utf-8", (err, text) => {
      if (err) {
        if (err.code === "ENOENT") {
          sendText(res, 404, `Not Found: ${POSTS_JSON_PATH}`);
          return;
        }
        sendText(res, 500, "Internal Server Error");
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendText(res, 500, "Failed to parse posts JSON");
        return;
      }

      const csv = toCsv(parsed);
      const headers = {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": "no-store",
      };
      if (req.method === "HEAD") {
        send(res, 200, headers, "");
        return;
      }
      send(res, 200, headers, csv);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api") {
    sendJson(res, 200, { message: "🌊 Ocean API is working!" });
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

    // SPA fallback: serve index.html for non-file routes.
    serveFile(res, path.join(PUBLIC_DIR, "index.html"));
  });
});

if (require.main === module) {
  const onListening = () => {
    const address = server.address();
    const resolvedHost = typeof address === "string" ? address : address?.address;
    const resolvedPort = typeof address === "string" ? PORT : address?.port;
    const displayHost = resolvedHost === "::" || resolvedHost === "0.0.0.0" ? "localhost" : resolvedHost;
    // eslint-disable-next-line no-console
    console.log(`🌊 Server running at http://${displayHost}:${resolvedPort}`);
  };

  if (HOST) {
    server.listen(PORT, HOST, onListening);
  } else {
    // Listen on all interfaces (IPv4+IPv6) by default so `localhost` works.
    server.listen(PORT, onListening);
  }
}

module.exports = {
  inferCoords,
  toCsv,
  toGeoJsonFeatureCollection,
};
