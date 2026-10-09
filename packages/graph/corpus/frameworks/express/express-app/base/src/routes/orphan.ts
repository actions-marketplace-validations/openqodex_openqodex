import { Router } from "express";
import type { Request, Response } from "express";

// Never mounted on an application: its route is registered but not served.
export const orphanRouter = Router();

function lost(_req: Request, res: Response): void {
  res.status(410).end();
}

orphanRouter.get("/lost", lost);
