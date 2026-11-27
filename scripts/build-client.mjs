#!/usr/bin/env node
/**
 * Zero-dependency deterministic client bundler for dsh-fintax.
 * Assembles modular ES source files under `src/client/*` into the self-contained
 * `client.js` bundle compatible with DSH's `window.__ModuleLoader__.load(...)` contract.
 *
 * Usage:
 *   node scripts/build-client.mjs          # Build/update client.js
 *   node scripts/build-client.mjs --check  # Verify client.js matches src/client/* byte-for-byte
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC_DIR = resolve(ROOT, 'src', 'client')
const OUT_FILE = resolve(ROOT, 'client.js')

// Strict topological build order (deterministic, zero ambiguity).
export const CLIENT_MODULES = [
  'constants.js',
  'i18n.js',
  'styles.js',
  'api.js',
  'components.js',
  'calc_specs_base.js',
  'calc_specs.js',
  'ima_drawer.js',
  'stage3_panel.js',
  'audit_tables.js',
  'tab_audit.js',
  'tab_calc.js',
  'tab_annual.js',
  'settings.js',
  'main.js',
]

function normalizeEol(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function transformModuleSource(filename, rawSource) {
  const lines = normalizeEol(rawSource).split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Strip single-line relative imports between bundled src/client modules.
    if (/^\s*import\s+.+\s+from\s+['"]\.\/[^'"]+\.js['"]\s*;?\s*$/.test(line)) continue
    // Reject unexpected external runtime imports (enforce strict zero-dep bundle).
    if (/^\s*import\s+/.test(line)) {
      throw new Error(`[build-client] External or multi-line import forbidden in src/client/${filename}:${i + 1}: ${line}`)
    }
    // Strip top-level `export ` modifiers while keeping declarations intact.
    if (/^export\s+default\s+/.test(line)) {
      throw new Error(`[build-client] Use named exports in src/client/${filename}:${i + 1}`)
    }
    const stripped = line.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/, '')
    kept.push(stripped)
  }
  const body = kept.join('\n').trim()
  const indented = body
    .split('\n')
    .map((l) => (l.length ? `    ${l}` : ''))
    .join('\n')
  return `    // ── module: src/client/${filename} ──\n${indented}`
}

export function assembleClientBundle() {
  const hash = createHash('sha256')
  const sections = []
  for (const mod of CLIENT_MODULES) {
    const fullPath = resolve(SRC_DIR, mod)
    if (!existsSync(fullPath)) {
      throw new Error(`[build-client] Missing required source module: src/client/${mod}`)
    }
    const raw = normalizeEol(readFileSync(fullPath, 'utf8'))
    hash.update(`--- ${mod} ---\n${raw}\n`)
    sections.push(transformModuleSource(mod, raw))
  }
  const sourceHash = hash.digest('hex').slice(0, 16)

  const header = [
    '/**',
    ' * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.',
    ' * Generated from `src/client/*` via `node scripts/build-client.mjs` (zero-dependency deterministic build).',
    ` * Modules (${CLIENT_MODULES.length}): ${CLIENT_MODULES.join(', ')}`,
    ` * Source SHA-256 (prefix): ${sourceHash}`,
    ' *',
    ' * dsh-fintax v0.9.0 — 桌面端独立财税工作台 + 图形化设置页（免构建 ModuleLoader 单文件产物）。',
    ' * 设计语言：Dieter Rams / Braun 精密计算仪器风（哑光铝壳 + 橄榄绿 LCD 屏 + 动态双指针红线表盘 + 信号橙预警）。',
    ' * 挂载槽位：sidebar.panellist + main、settings.section.icon、settings.section、conversation.input.dock（DSH 0.2.3+ 安全探测）。',
    ' */',
  ].join('\n')

  const bundle = [
    header,
    "window.__ModuleLoader__.load({",
    "  id: 'dsh-fintax',",
    '  factory(require) {',
    "    const React = require('react')",
    '    const { createElement: h, useState, useEffect, useCallback, useMemo, useRef } = React',
    '',
    sections.join('\n\n'),
    '',
    '    return createPluginEntry()',
    '  },',
    '})',
    '',
  ].join('\n')

  return { bundle, sourceHash, moduleCount: CLIENT_MODULES.length }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const checkMode = process.argv.includes('--check')
  const { bundle, sourceHash, moduleCount } = assembleClientBundle()
  const expectedBuf = Buffer.from(bundle, 'utf8')

  if (checkMode) {
    if (!existsSync(OUT_FILE)) {
      console.error('[build-client] FAIL: client.js does not exist. Run `node scripts/build-client.mjs`.')
      process.exit(1)
    }
    const actualNorm = normalizeEol(readFileSync(OUT_FILE, 'utf8'))
    const actualBuf = Buffer.from(actualNorm, 'utf8')
    if (Buffer.compare(actualBuf, expectedBuf) !== 0) {
      console.error(`[build-client] FAIL: client.js is out of sync with src/client/* (expected ${expectedBuf.length} bytes, actual ${actualBuf.length} bytes, hash=${sourceHash}).`)
      console.error('[build-client] Run `node scripts/build-client.mjs` to regenerate client.js.')
      process.exit(1)
    }
    console.log(`[build-client] OK: client.js matches src/client/* (${moduleCount} modules, ${expectedBuf.length} bytes, hash=${sourceHash}).`)
    process.exit(0)
  }

  writeFileSync(OUT_FILE, expectedBuf)
  console.log(`[build-client] Built client.js from ${moduleCount} modules (${expectedBuf.length} bytes, hash=${sourceHash}).`)
}
