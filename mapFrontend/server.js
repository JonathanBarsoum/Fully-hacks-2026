const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
// Bind explicitly to localhost to avoid sandbox/container restrictions on 0.0.0.0.
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

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

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  const stream = fs.createReadStream(filePath);
  stream.on("open", () => {
    res.writeHead(200, { "content-type": contentType });
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

const server = http.createServer((req, res) => {
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

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`🌊 Server running at http://${HOST}:${PORT}`);
});
