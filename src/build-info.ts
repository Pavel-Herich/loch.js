declare const __BUILD_INFO__: { version: string; commit: string; builtAt: string };

// Vite embeds this at build time, including in packaged desktop applications.
export const buildInfo = __BUILD_INFO__;
