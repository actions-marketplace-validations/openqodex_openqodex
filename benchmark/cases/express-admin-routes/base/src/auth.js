// Lets the request through only for an administrator; the session
// middleware has set req.user before this runs.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return;
  }
  next();
}
