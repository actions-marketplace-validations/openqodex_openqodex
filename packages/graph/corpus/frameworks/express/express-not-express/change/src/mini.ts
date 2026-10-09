import type { Request } from "express";

type Handler = (path: string) => string;

// A router of the repository's own, with the method names Express uses.
export class MiniRouter {
  private routes = new Map<string, Handler>();

  get(path: string, handler: Handler): void {
    this.routes.set(path, handler);
  }

  use(prefix: string, other: MiniRouter): void {
    for (const [path, handler] of other.routes) this.routes.set(prefix + path, handler);
  }
}

// A local function named like the express module's default export.
function express(): MiniRouter {
  return new MiniRouter();
}

export function home(path: string): string {
  return `home ${path}`;
}

export function describeRequest(req: Request): string {
  return req.url;
}

export const app = express();
const router = new MiniRouter();
router.get("/inner", home);
app.get("/", home);
app.use("/nested", router);
