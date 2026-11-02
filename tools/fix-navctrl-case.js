#!/usr/bin/env node
// hexo-butterfly-navctrl@1.0.4 的包里文件名是 lib/navCtrl.pug 和 lib/navCtrl.css，
// 但 index.js 里按 lib/navctrl.pug、lib/navctrl.css 引用。
// Windows 文件系统不区分大小写，本地能跑；Linux（Vercel/Netlify/CI）区分大小写，
// 于是报 ENOENT: .../lib/navctrl.pug。
// 这个脚本在 npm install 之后补一份小写文件名的副本，兼容两种环境。
'use strict'

const fs = require('fs')
const path = require('path')

const pkg = path.join(__dirname, '..', 'node_modules', 'hexo-butterfly-navctrl')
const libDir = path.join(pkg, 'lib')

const pairs = [
  ['navCtrl.pug', 'navctrl.pug'],
  ['navCtrl.css', 'navctrl.css'],
]

function readEntries(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return null
  }
}

const entries = readEntries(libDir)
if (!entries) {
  // 没装这个插件，直接跳过
  process.exit(0)
}

let copied = 0
for (const [srcName, dstName] of pairs) {
  // 用 readdir 的结果做精确比较，避免 existsSync 在 Windows 上把 navCtrl.pug 当成 navctrl.pug
  if (entries.includes(dstName)) continue
  const src = path.join(libDir, srcName)
  if (!entries.includes(srcName)) continue
  fs.copyFileSync(src, path.join(libDir, dstName))
  // 大小写不敏感的文件系统（Windows/macOS 默认）上复制完读到的还是原文件名，说明本来就不需要处理
  if (readEntries(libDir).includes(dstName)) copied++
}

if (copied) {
  console.log(`[fix-navctrl-case] 已补齐 ${copied} 个大小写不一致的文件`)
}
