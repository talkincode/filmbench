import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Service } from "./service.ts";

/** 给视频产物抽一张首帧当封面（故事板、抽屉缩略图都用它） */
export async function ensurePosters(service: Service): Promise<number> {
  let made = 0;
  const dir = join(service.dir, "build", "posters");
  for (const shot of service.state().shots) {
    const produce = shot.produce;
    if (!produce || produce.kind !== "video") continue;
    const target = join(dir, `${produce.asset}.jpg`);
    if (existsSync(target)) continue;
    mkdirSync(dir, { recursive: true });
    const src = produce.path.startsWith("/") ? produce.path : join(service.dir, produce.path);
    const proc = Bun.spawn(
      ["ffmpeg", "-y", "-ss", "0.05", "-i", src, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", target],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await proc.exited) === 0) made++;
  }
  return made;
}
