'use strict';
/**
 * electron-builder afterPack hook (Windows only).
 * We build with signAndEditExecutable=false (no wine/rcedit), so electron-builder
 * never embeds our icon or version info into the exe. Do it here with resedit (pure JS).
 *
 * Also usable standalone:  node scripts/after-pack.js <path-to-exe> [icon.ico]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LANG = 1033; // en-US
const CODEPAGE = 1200; // Unicode

function patchExe(exePath, opts = {}) {
  const ResEdit = require('resedit');
  const pkg = require(path.join(ROOT, 'package.json'));
  const iconPath = opts.icon || path.join(ROOT, 'build', 'icon.ico');
  const productName = opts.productName || pkg.productName || 'mem0';
  const version = String(opts.version || pkg.version);

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // --- icon: replace every existing icon group (Electron ships one, id 1) ---
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const icons = iconFile.icons.map((i) => i.data);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const targets = groups.length ? groups.map((g) => ({ id: g.id, lang: g.lang })) : [{ id: 1, lang: LANG }];
  for (const t of targets) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, t.id, t.lang, icons);
  }

  // --- version info ---
  const parts = version.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  while (parts.length < 4) parts.push(0);
  const [ma, mi, pa, bu] = parts;
  let vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (!vi) vi = ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(ma, mi, pa, bu, LANG);
  vi.setProductVersion(ma, mi, pa, bu, LANG);
  // wipe Electron's strings for whatever languages exist, then write ours
  const langs = vi.getAllLanguagesForStringValues();
  for (const l of langs) {
    for (const key of ['ProductName', 'FileDescription', 'CompanyName', 'LegalCopyright', 'OriginalFilename', 'InternalName']) {
      vi.removeStringValue(l, key);
    }
  }
  const strLang = langs[0] || { lang: LANG, codepage: CODEPAGE };
  vi.setStringValues(strLang, {
    ProductName: productName,
    FileDescription: productName,
    CompanyName: productName,
    InternalName: productName,
    OriginalFilename: path.basename(exePath),
    FileVersion: version,
    ProductVersion: version,
    LegalCopyright: `Copyright (c) ${new Date().getFullYear()} ${productName}`,
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return { exePath, iconGroups: targets.map((t) => t.id), version };
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const name = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${name}.exe`);
  if (!fs.existsSync(exePath)) throw new Error(`[after-pack] exe not found: ${exePath}`);
  const r = patchExe(exePath, { version: context.packager.appInfo.version, productName: context.packager.appInfo.productName });
  console.log(`[after-pack] embedded icon + version ${r.version} into ${exePath}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.patchExe = patchExe;

if (require.main === module) {
  const [exe, icon] = process.argv.slice(2);
  if (!exe) { console.error('usage: node scripts/after-pack.js <exe> [icon.ico]'); process.exit(1); }
  console.log(patchExe(exe, { icon }));
}
