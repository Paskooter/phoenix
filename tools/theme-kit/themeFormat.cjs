// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, pasketti and the Phoenix project.
'use strict';
// Author-facing schema-2 manifest and image validation. See docs/THEMES.md.
// Theme packs contain data, never code or view configs.
var crypto = require('crypto');
var format = require('./format.cjs');

var RUNTIME = 'phoenix-menu-theme-v1';
var MAGIC = 'PHXTHM1\n';
var HEADER_BYTES = 12;
var LIMITS = { manifestBytes: 65536, artifactBytes: 8388608, assets: 64, assetBytes: 1048576, totalPixels: 4194304,
    themes: 8, diskBytes: 83886080, depth: 12, members: 64 };
var APP_ID = /^app-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var HASH = /^[a-f0-9]{64}$/;
var ASSET_ID = /^[a-z][a-z0-9-]{0,39}$/;
var COLOR = /^#[A-Fa-f0-9]{6}$/;
var MENU_KEY = /^@(?:be|phoenix)\/[a-z0-9-]+#[A-Za-z][A-Za-z0-9_-]*$/;
var ITEM_ID = /^[A-Za-z0-9_-]+$/;
var FONTS = ['Proxima Nova Soft', 'Proxima Nova Light', 'Proxima Nova'];
var LAYOUTS = ['native', 'slide'];
var ROLES = { background: { width: 1280, height: 720, types: ['image/png', 'image/jpeg'] },
    icon: { width: 256, height: 256, types: ['image/png'] }, preview: { width: 720, height: 720, types: ['image/png', 'image/jpeg'] } };
var FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'];
var EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg' };
function fail(code) { var e = new Error(code); e.code = code; e.status = 400; e.themeReject = true; throw e; }
function own(v, key) { return Object.prototype.hasOwnProperty.call(v, key); }
function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function keys(v, allowed, required, code) {
    if (!plain(v) || Object.keys(v).some(function (key) { return allowed.indexOf(key) < 0; }) ||
        required.some(function (key) { return !own(v, key); })) fail(code || 'theme_invalid');
}
// Single-line text rejects every control character; long text permits only
// tab and line breaks, as the schema-1 format does.
function text(v, max, empty, multiline) {
    var control = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    if (typeof v !== 'string' || v.length > max || (!empty && (!v.length || !v.trim())) || control.test(v)) fail('theme_text_invalid');
}
function match(v, pattern, code) { if (typeof v !== 'string' || !pattern.test(v)) fail(code || 'theme_invalid'); }
function integer(v, min, max, code) { if (!Number.isSafeInteger(v) || v < min || v > max) fail(code || 'theme_invalid'); }
function same(a, b) { return format.canonical(a) === format.canonical(b); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function version(v) { if (typeof v !== 'string') fail('invalid_version'); try { format.compareVersion(v, v); } catch (_) { fail('invalid_version'); } }

// Strict, bounded JSON: no duplicate or prototype keys, bounded depth and
// member counts, finite numbers. Built only from {} / [] / primitives.
function parseStrict(input, limits) {
    var source = Buffer.isBuffer(input) ? input.toString('utf8') : input;
    var maxDepth = (limits && limits.depth) || LIMITS.depth, maxMembers = (limits && limits.members) || LIMITS.members;
    if (typeof source !== 'string') fail('theme_json_invalid');
    if (Buffer.isBuffer(input) && !Buffer.from(source, 'utf8').equals(input)) fail('theme_json_invalid');
    var i = 0;
    function ws() { while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r')) i++; }
    function string() {
        if (source[i] !== '"') fail('theme_json_invalid');
        i++; var out = '';
        for (;;) {
            if (i >= source.length) fail('theme_json_invalid');
            var c = source[i++];
            if (c === '"') return out;
            if (c < ' ') fail('theme_json_invalid');
            if (c !== '\\') { out += c; continue; }
            var e = source[i++];
            if (e === 'u') {
                var hex = source.slice(i, i + 4);
                if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail('theme_json_invalid');
                out += String.fromCharCode(parseInt(hex, 16)); i += 4;
            } else {
                var map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
                if (!own(map, e)) fail('theme_json_invalid');
                out += map[e];
            }
        }
    }
    function value(depth) {
        if (depth > maxDepth) fail('theme_json_too_deep');
        ws();
        var c = source[i];
        if (c === '{') {
            i++; var object = {}, count = 0; ws();
            if (source[i] === '}') { i++; return object; }
            for (;;) {
                ws(); var key = string();
                if (FORBIDDEN_KEYS.indexOf(key) >= 0) fail('theme_json_forbidden_key');
                if (own(object, key)) fail('theme_json_duplicate_key');
                if (++count > maxMembers) fail('theme_json_too_large');
                ws(); if (source[i++] !== ':') fail('theme_json_invalid');
                object[key] = value(depth + 1); ws();
                c = source[i++];
                if (c === '}') return object;
                if (c !== ',') fail('theme_json_invalid');
            }
        }
        if (c === '[') {
            i++; var array = []; ws();
            if (source[i] === ']') { i++; return array; }
            for (;;) {
                if (array.length >= maxMembers) fail('theme_json_too_large');
                array.push(value(depth + 1)); ws();
                c = source[i++];
                if (c === ']') return array;
                if (c !== ',') fail('theme_json_invalid');
            }
        }
        if (c === '"') return string();
        var literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(i, i + 40));
        if (!literal) fail('theme_json_invalid');
        i += literal[0].length;
        if (literal[0] === 'true') return true;
        if (literal[0] === 'false') return false;
        if (literal[0] === 'null') return null;
        var number = Number(literal[0]);
        if (!isFinite(number) || (/^-?[0-9]+$/.test(literal[0]) && !Number.isSafeInteger(number))) fail('theme_json_invalid');
        return number;
    }
    var result = value(1); ws();
    if (i !== source.length) fail('theme_json_invalid');
    return result;
}

// WCAG 2 relative luminance contrast of two #RRGGBB colors.
function luminance(color) {
    var channels = [1, 3, 5].map(function (at) {
        var c = parseInt(color.slice(at, at + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(a, b) { var x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

function palette(p) {
    var names = ['background', 'surface', 'surfaceSecondary', 'text', 'mutedText', 'accent'];
    keys(p, names, names);
    names.forEach(function (name) { match(p[name], COLOR, 'theme_color_invalid'); });
    // Text on both solid surfaces and on the solid backing (background);
    // accent borders against the surface. Invalid palettes are rejected,
    // never silently adjusted.
    ['surface', 'surfaceSecondary', 'background'].forEach(function (name) { if (contrast(p.text, p[name]) < 4.5) fail('theme_contrast_insufficient'); });
    if (contrast(p.accent, p.surface) < 3) fail('theme_contrast_insufficient');
}
function fonts(f) {
    var names = ['titleFamily', 'labelFamily', 'titleSize', 'labelSize'];
    keys(f, names, names);
    if (FONTS.indexOf(f.titleFamily) < 0 || FONTS.indexOf(f.labelFamily) < 0) fail('theme_font_invalid');
    integer(f.titleSize, 48, 100, 'theme_font_invalid'); integer(f.labelSize, 40, 56, 'theme_font_invalid');
}
function background(b, uses) {
    keys(b, ['asset', 'opacity'], ['asset', 'opacity']);
    if (typeof b.opacity !== 'number' || !isFinite(b.opacity) || b.opacity < 0 || b.opacity > 0.35) fail('theme_background_invalid');
    if (b.asset !== null) { match(b.asset, ASSET_ID); uses.push({ id: b.asset, role: 'background' }); }
}

function validateManifest(manifest, expectedAppId) {
    var m = manifest;
    keys(m, ['schema', 'kind', 'runtime', 'appId', 'version', 'minFirmware', 'name', 'description', 'releaseNotes', 'permissions', 'launchNames', 'themeApi', 'theme', 'assets'],
        ['schema', 'kind', 'runtime', 'appId', 'version', 'minFirmware', 'name', 'description', 'releaseNotes', 'permissions', 'launchNames', 'themeApi', 'theme', 'assets']);
    if (m.schema !== 2 || m.kind !== 'theme' || m.runtime !== RUNTIME || m.themeApi !== 1) fail('invalid_identity_or_runtime');
    match(m.appId, APP_ID, 'invalid_identity_or_runtime');
    if (expectedAppId && m.appId !== expectedAppId) fail('invalid_identity_or_runtime');
    version(m.version); version(m.minFirmware);
    text(m.name, 60); text(m.description, 1200, false, true); text(m.releaseNotes, 1200, true, true);
    if (!same(m.permissions, ['menu-theme'])) fail('invalid_permissions');
    if (!same(m.launchNames, [])) fail('invalid_launch_names');
    var t = m.theme, uses = [];
    keys(t, ['layout', 'palette', 'fonts', 'background', 'previewAsset', 'storeAppIcon', 'overrides'], ['layout', 'palette', 'fonts', 'background', 'overrides']);
    if (LAYOUTS.indexOf(t.layout) < 0) fail('theme_layout_invalid');
    palette(t.palette); fonts(t.fonts); background(t.background, uses);
    if (own(t, 'previewAsset')) { match(t.previewAsset, ASSET_ID); uses.push({ id: t.previewAsset, role: 'preview' }); }
    if (own(t, 'storeAppIcon')) { match(t.storeAppIcon, ASSET_ID); uses.push({ id: t.storeAppIcon, role: 'icon' }); }
    if (!Array.isArray(t.overrides) || t.overrides.length > 32) fail('theme_overrides_invalid');
    var menuKeys = [];
    t.overrides.forEach(function (o) {
        keys(o, ['menuKey', 'layout', 'palette', 'fonts', 'background', 'icons'], ['menuKey']);
        if (typeof o.menuKey !== 'string' || o.menuKey.length > 120 || !MENU_KEY.test(o.menuKey)) fail('theme_menu_key_invalid');
        if (menuKeys.indexOf(o.menuKey) >= 0) fail('theme_duplicate_override'); menuKeys.push(o.menuKey);
        if (own(o, 'layout') && LAYOUTS.indexOf(o.layout) < 0) fail('theme_layout_invalid');
        if (own(o, 'palette')) palette(o.palette);
        if (own(o, 'fonts')) fonts(o.fonts);
        if (own(o, 'background')) background(o.background, uses);
        if (own(o, 'icons')) {
            if (!Array.isArray(o.icons) || o.icons.length > 64) fail('theme_icons_invalid');
            var items = [];
            o.icons.forEach(function (icon) {
                keys(icon, ['itemId', 'asset'], ['itemId', 'asset']);
                if (typeof icon.itemId !== 'string' || !icon.itemId.length || icon.itemId.length > 80 || !ITEM_ID.test(icon.itemId)) fail('theme_item_invalid');
                if (items.indexOf(icon.itemId) >= 0) fail('theme_duplicate_item'); items.push(icon.itemId);
                match(icon.asset, ASSET_ID); uses.push({ id: icon.asset, role: 'icon' });
            });
        }
    });
    if (!Array.isArray(m.assets) || m.assets.length > LIMITS.assets) fail('theme_assets_invalid');
    var ids = [], roleCount = { background: 0, preview: 0, icon: 0 }, pixels = 0, previous = '';
    m.assets.forEach(function (a) {
        keys(a, ['id', 'role', 'mediaType', 'sha256', 'bytes', 'width', 'height'], ['id', 'role', 'mediaType', 'sha256', 'bytes', 'width', 'height']);
        match(a.id, ASSET_ID);
        // Publishing orders assets lexically by ID, so blob order is canonical.
        if (ids.indexOf(a.id) >= 0) fail('theme_duplicate_asset');
        if (a.id <= previous) fail('theme_asset_order_invalid');
        previous = a.id; ids.push(a.id);
        if (!own(ROLES, a.role)) fail('theme_asset_role_invalid');
        var role = ROLES[a.role];
        if (role.types.indexOf(a.mediaType) < 0) fail('theme_media_type_invalid');
        match(a.sha256, HASH); integer(a.bytes, 1, LIMITS.assetBytes, 'theme_asset_too_large');
        integer(a.width, 1, role.width, 'theme_dimensions_invalid'); integer(a.height, 1, role.height, 'theme_dimensions_invalid');
        roleCount[a.role]++; pixels += a.width * a.height;
    });
    if (roleCount.background > 1 || roleCount.preview > 1) fail('theme_asset_role_invalid');
    if (pixels > LIMITS.totalPixels) fail('theme_pixels_exceeded');
    uses.forEach(function (use) {
        var asset = m.assets.filter(function (a) { return a.id === use.id; })[0];
        if (!asset) fail('theme_asset_missing');
        if (asset.role !== use.role) fail('theme_asset_role_invalid');
    });
    m.assets.forEach(function (a) { if (!uses.some(function (use) { return use.id === a.id; })) fail('theme_asset_unused'); });
    var bytes = Buffer.from(format.canonical(m), 'utf8');
    if (bytes.length > LIMITS.manifestBytes) fail('theme_manifest_too_large');
    return { manifest: JSON.parse(bytes.toString('utf8')), bytes: bytes };
}
// PNG: static, non-interlaced 8-bit RGB/RGBA; every chunk CRC checked; no
// animation chunks or trailing payload. Pixel data is checked by inflate.
var CRC_TABLE = (function () {
    var table = [];
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    return table;
})();
function crc32(bytes, start, end) {
    var c = 0xffffffff;
    for (var i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
var PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
var PNG_ALLOWED = ['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs'];
function inspectPng(bytes) {
    if (bytes.length < 57 || !bytes.slice(0, 8).equals(PNG_SIGNATURE)) fail('image_type_mismatch');
    var at = 8, header = null, idat = [], idatDone = false, ended = false, seen = [];
    while (at < bytes.length) {
        if (ended || at + 12 > bytes.length) fail('image_invalid');
        var length = bytes.readUInt32BE(at), type = bytes.toString('binary', at + 4, at + 8);
        if (length > 0x7fffffff || at + 12 + length > bytes.length) fail('image_invalid');
        if (crc32(bytes, at + 4, at + 8 + length) !== bytes.readUInt32BE(at + 8 + length)) fail('image_invalid');
        if (!/^[A-Za-z]{4}$/.test(type) || PNG_ALLOWED.indexOf(type) < 0) fail('image_chunk_rejected');
        if ((header === null) !== (type === 'IHDR')) fail('image_invalid');
        if (type !== 'IDAT' && type !== 'IEND' && seen.indexOf(type) >= 0) fail('image_invalid');
        seen.push(type);
        var data = bytes.slice(at + 8, at + 8 + length);
        if (type === 'IHDR') {
            if (length !== 13) fail('image_invalid');
            header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], compression: data[10], filter: data[11], interlace: data[12] };
            if (header.depth !== 8 || (header.color !== 2 && header.color !== 6) || header.compression || header.filter || header.interlace) fail('image_format_rejected');
        } else if (type === 'IDAT') {
            if (idatDone) fail('image_invalid');
            idat.push(data);
        } else {
            if (idat.length) idatDone = true;
            if (type === 'IEND') { if (length) fail('image_invalid'); ended = true; }
        }
        at += 12 + length;
    }
    if (!ended || !idat.length) fail('image_invalid');
    return { mediaType: 'image/png', width: header.width, height: header.height, channels: header.color === 6 ? 4 : 3, data: Buffer.concat(idat) };
}
// JPEG: one baseline (SOF0) 8-bit three-component frame, JFIF APP0 only, no
// metadata/comment segments, nothing after EOI (no appended second image).
function inspectJpeg(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('image_type_mismatch');
    var at = 2, frame = null, scanned = false;
    for (;;) {
        if (at + 2 > bytes.length || bytes[at] !== 0xff) fail('image_invalid');
        var marker = bytes[at + 1];
        if (marker === 0xd9) { if (!scanned || at + 2 !== bytes.length) fail('image_invalid'); break; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) fail('image_invalid');
        if (at + 4 > bytes.length) fail('image_invalid');
        var length = bytes.readUInt16BE(at + 2);
        if (length < 2 || at + 2 + length > bytes.length) fail('image_invalid');
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (marker !== 0xc0 || frame) fail('image_format_rejected');
            if (length !== 17 || bytes[at + 4] !== 8 || bytes[at + 9] !== 3) fail('image_format_rejected');
            frame = { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
        } else if (marker === 0xda) {
            if (!frame) fail('image_invalid');
            at += 2 + length;
            // Entropy-coded data: stuffed 0xFF00 and restart markers only.
            while (at + 1 < bytes.length && !(bytes[at] === 0xff && bytes[at + 1] !== 0x00 && !(bytes[at + 1] >= 0xd0 && bytes[at + 1] <= 0xd7))) at++;
            scanned = true; continue;
        } else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
            fail('image_metadata_rejected');
        } else if (marker === 0xe0) {
            if (bytes.toString('binary', at + 4, at + 9) !== 'JFIF\u0000') fail('image_metadata_rejected');
        } else if ([0xc4, 0xdb, 0xdd].indexOf(marker) < 0) {
            fail('image_invalid');
        }
        at += 2 + length;
    }
    if (!frame || !frame.width || !frame.height) fail('image_invalid');
    return { mediaType: 'image/jpeg', width: frame.width, height: frame.height };
}
// Structural check of one blob against its signed manifest entry.
function inspectImage(bytes, asset) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) fail('artifact_integrity_failed');
    var info = asset.mediaType === 'image/png' ? inspectPng(bytes) : asset.mediaType === 'image/jpeg' ? inspectJpeg(bytes) : fail('theme_media_type_invalid');
    if (info.width !== asset.width || info.height !== asset.height) fail('image_dimensions_mismatch');
    return info;
}

module.exports = { RUNTIME, MAGIC, HEADER_BYTES, LIMITS, APP_ID, FONTS, LAYOUTS, ROLES, parseStrict, contrast, sha256, validateManifest, inspectPng, inspectJpeg, inspectImage };
