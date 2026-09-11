// Serve a built documentation site over HTTP.

import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export type ServeOptions = {
  host?: string;
  port?: number;
};

/** Start a static file server. Resolves when the server is listening. */
export function serveStaticSite(
  rootDir: string,
  options: ServeOptions = {},
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const root = normalize(rootDir);

  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const raw = request.url?.split("?")[0] ?? "/";
      const pathname = decodeURIComponent(raw);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
      const file = normalize(join(root, relative));

      if (!file.startsWith(root) || !existsSync(file)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const stats = statSync(file);
      if (stats.isDirectory()) {
        const index = join(file, "index.html");
        if (!existsSync(index)) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        streamFile(index, response);
        return;
      }

      streamFile(file, response);
    });

    server.on("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function streamFile(file: string, response: import("node:http").ServerResponse): void {
  const type = MIME[extname(file)] ?? "application/octet-stream";
  response.writeHead(200, { "Content-Type": type });
  createReadStream(file).pipe(response);
}
