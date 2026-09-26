import { spawnSync } from "node:child_process";

/** True when `command` is on PATH and responds to `-version` (cross-platform). */
export function isExecutableOnPath(command: string): boolean {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const err = result.error as NodeJS.ErrnoException | undefined;
  if (err?.code === "ENOENT") {
    return false;
  }
  return result.status === 0;
}

export const ffmpegOnPath = isExecutableOnPath("ffmpeg");
