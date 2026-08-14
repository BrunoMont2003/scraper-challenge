import { existsSync, renameSync, rmSync } from "node:fs";

export function temporarySibling(targetPath: string): string {
  return `${targetPath}.tmp`;
}

export function removeTemporary(path: string): void {
  rmSync(path, { force: true });
}

export function commitTemporary(temporaryPath: string, targetPath: string): void {
  renameSync(temporaryPath, targetPath);
}

export async function atomicReplace(
  targetPath: string,
  write: (temporaryPath: string) => Promise<void>,
  validate: (temporaryPath: string) => Promise<void> | void = () => undefined,
): Promise<void> {
  const temporaryPath = temporarySibling(targetPath);
  removeTemporary(temporaryPath);
  try {
    await write(temporaryPath);
    await validate(temporaryPath);
    commitTemporary(temporaryPath, targetPath);
  } catch (error) {
    if (existsSync(temporaryPath)) removeTemporary(temporaryPath);
    throw error;
  }
}
