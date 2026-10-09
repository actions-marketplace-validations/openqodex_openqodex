export function ping(_req: unknown, res: { send(body: string): void }): void {
  res.send("pong");
}
