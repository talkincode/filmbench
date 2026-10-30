import {afterAll, describe, expect, test} from "bun:test";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, {recursive: true, force: true})));

const cli = (args: string[]) =>
  Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {stdout: "pipe", stderr: "pipe"});

describe("filmbench install（内置 skill）", () => {
  test("装到指定目录，内容与仓库里的一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-skill-"));
    dirs.push(dir);
    const r = cli(["install", "--dir", dir]);
    expect(r.exitCode).toBe(0);
    const installed = join(dir, "filmbench", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    const source = readFileSync(join(import.meta.dir, "../../../skills/filmbench/SKILL.md"), "utf8");
    expect(readFileSync(installed, "utf8")).toBe(source);
    // skill 必须有 frontmatter 与 name
    expect(source.startsWith("---\nname: filmbench")).toBe(true);
  });

  test("重复安装不覆盖（要 --force），--check 能查到", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-skill-"));
    dirs.push(dir);
    expect(cli(["install", "--dir", dir]).exitCode).toBe(0);
    const again = cli(["install", "--dir", dir]);
    expect(again.stdout.toString()).toContain("已是");
    const check = cli(["install", "--dir", dir, "--check"]);
    expect(check.stdout.toString()).toContain("✓");
  });
});
