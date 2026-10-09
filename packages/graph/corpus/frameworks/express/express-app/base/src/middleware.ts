import type { NextFunction, Request, Response } from "express";

export function logRequests(req: Request, _res: Response, next: NextFunction): void {
  console.log(req.method, req.url);
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization) {
    res.status(401).end();
    return;
  }
  next();
}

export function validate(req: Request, res: Response, next: NextFunction): void {
  if (typeof req.body?.name !== "string") {
    res.status(400).end();
    return;
  }
  next();
}

export function onError(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  res.status(500).json({ error: err.message });
}
