import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PermissionDeniedError } from "../core/errors.js";

export class WorkspaceBoundary {
  readonly root: string;
  private realRootPromise: Promise<string> | undefined;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * 沙箱根的真实路径，惰性求值且只求一次。
   *
   * 不能在构造函数里直接发起 `fs.realpath()`：那个 promise 在调用方 await 它之前就
   * 可能 reject（根目录不存在时便是如此），成为 unhandled rejection 直接终止进程。
   * 那会让驱动在写出任何结果之前就死掉，把一次本可归因的失败变成无结构的崩溃。
   * 惰性化之后，拒绝由真正 await 它的调用方接管，错误沿调用栈正常上抛。
   */
  private realRoot(): Promise<string> {
    this.realRootPromise ??= fs.realpath(this.root);
    return this.realRootPromise;
  }

  async resolveExisting(candidate: string): Promise<string> {
    const resolved = this.resolveLexically(candidate);
    const realPath = await fs.realpath(resolved);
    this.assertInside(await this.realRoot(), realPath, candidate);
    return resolved;
  }

  async resolveWritable(candidate: string): Promise<string> {
    const resolved = this.resolveLexically(candidate);
    const existingAncestor = await this.findExistingAncestor(resolved);
    const realAncestor = await fs.realpath(existingAncestor);
    this.assertInside(await this.realRoot(), realAncestor, candidate);
    return resolved;
  }

  private resolveLexically(candidate: string): string {
    const resolved = path.resolve(this.root, candidate);
    this.assertInside(this.root, resolved, candidate);
    return resolved;
  }

  private async findExistingAncestor(candidate: string): Promise<string> {
    let current = candidate;
    while (true) {
      try {
        await fs.lstat(current);
        return current;
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }

  private assertInside(root: string, candidate: string, requested: string): void {
    const relative = path.relative(root, candidate);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      return;
    }
    throw new PermissionDeniedError(`Access denied: path ${requested} is outside of workspace`);
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
