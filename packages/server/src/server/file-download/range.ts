import type { Request, Response } from "express";
export function selectDownloadRange(
  req: Request,
  res: Response,
  size: number,
): { start: number; end: number } | null | false {
  const ranges = req.range(size);
  if (
    ranges === -1 ||
    ranges === -2 ||
    (ranges && (ranges.type !== "bytes" || ranges.length !== 1))
  ) {
    res.setHeader("Content-Range", `bytes */${size}`);
    res.setHeader("Content-Length", "0");
    res.status(416).end();
    return false;
  }
  if (!ranges) return null;
  const range = ranges[0]!;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  res.setHeader("Content-Length", String(range.end - range.start + 1));
  return range;
}
