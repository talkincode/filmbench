import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { StoryboardDoc } from "./types.ts";

/**
 * 把投影里的绝对预览路径改写成页面能用的 URL。
 * 默认用相对于 HTML 的路径（项目目录里的 assets 不用复制），--embed 时内联成 data URI，
 * 这样单文件可以脱离项目目录发给别人。
 */
export function resolvePreviews(
  doc: StoryboardDoc,
  htmlDir: string,
  options: { embed?: boolean } = {},
): StoryboardDoc {
  const mime = (p: string) =>
    p.endsWith(".png") ? "image/png" : p.endsWith(".webp") ? "image/webp" : "image/jpeg";

  for (const shot of doc.shots) {
    for (const produce of shot.produces ?? []) {
      const abs = produce.preview;
      if (!abs) {
        produce.preview = null;
        continue;
      }
      try {
        if (options.embed) {
          produce.preview = `data:${mime(abs)};base64,${readFileSync(abs).toString("base64")}`;
        } else {
          const rel = relative(htmlDir, resolve(abs)).split("\\").join("/");
          produce.preview = encodeURI(rel.startsWith(".") ? rel : `./${rel}`);
        }
      } catch {
        produce.preview = null;
      }
    }
  }
  return doc;
}
