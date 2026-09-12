// web-ext configuration. Keeps dev-only files out of the published .zip so the
// add-on ships nothing but what it needs to run. (web-ext already ignores .git,
// node_modules, and web-ext-artifacts automatically.)
module.exports = {
  ignoreFiles: [
    "sync_branding.py", // dev tool: syncs branding to content.js maxPercent
    "web-ext-config.cjs", // this file
    "scratchpad.md", // scratch notes
    "tab-volume-booster.code-workspace", // editor workspace
    "README.md", // dev docs; the AMO listing carries the user-facing copy
    "package.json",
    "package-lock.json",
  ],
};
