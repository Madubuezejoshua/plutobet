"use strict";

// Some Windows sandboxed processes cannot resolve the current account through
// libuv and make os.userInfo() throw ERR_SYSTEM_ERROR/uv_os_get_passwd. Tools
// such as drizzle-kit only need a stable username for their temporary path.
// Preserve Node's native result everywhere it works and narrowly fall back to
// environment data for that one native lookup failure.
// CommonJS is required because Node loads this file through `--require`
// before drizzle-kit's ESM entry point is evaluated.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");

const nativeUserInfo = os.userInfo.bind(os);

os.userInfo = function userInfoWithFallback(options) {
  try {
    return nativeUserInfo(options);
  } catch (error) {
    const isPasswdLookupFailure =
      error?.code === "ERR_SYSTEM_ERROR" &&
      error?.info?.syscall === "uv_os_get_passwd";

    if (!isPasswdLookupFailure) throw error;

    const windowsHome =
      process.env.HOMEDRIVE && process.env.HOMEPATH
        ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
        : undefined;

    return {
      uid: typeof process.getuid === "function" ? process.getuid() : -1,
      gid: typeof process.getgid === "function" ? process.getgid() : -1,
      username:
        process.env.USERNAME ?? process.env.USER ?? process.env.LOGNAME ?? "unknown",
      homedir:
        process.env.USERPROFILE ?? process.env.HOME ?? windowsHome ?? process.cwd(),
      shell: process.env.SHELL ?? null,
    };
  }
};
