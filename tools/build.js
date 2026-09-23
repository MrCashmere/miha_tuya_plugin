/*
 * 构建：把 src/*.js 按文件名排序拼成一个 main.js。
 *
 * 为什么是「拼接」而不是打包器：
 * miha 宿主只读取 plugin.json 里 `entry` 指向的**那一个文件**，把内容原样包进
 * IIFE 用 runJavaScript 执行。所以 import / export 会直接语法错误，拆出去的文件
 * 永远不会被加载。唯一可行的多文件方案就是构建期拼接 —— 所有函数共享同一个闭包
 * 作用域，可以互相直接调用。
 *
 * 用法：
 *   node tools/build.js            # 生成 main.js
 *   node tools/build.js --check    # 只做语法检查，不写文件
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'main.js');

/** 生成文件头的注释块（模块清单要写在注释**里面**）。 */
function makeBanner(files) {
  const listLines = files.map(function (f) { return ' *   - ' + f; }).join('\n');
  return [
    '/* ============================================================================',
    ' * 涂鸦（Tuya / Tuya Local）— miha 插件',
    ' *',
    ' * 本文件由 tools/build.js 从 src 下的模块拼接生成，**不要直接改这里**。',
    ' * 要改就改 src/ 里对应的模块，然后重新跑：node tools/build.js',
    ' *',
    ' * 拼接顺序（按文件名排序）：',
    listLines,
    ' * ========================================================================== */',
    ''
  ].join('\n');
}

function collect() {
  const files = fs.readdirSync(SRC)
    .filter(function (f) { return f.endsWith('.js'); })
    .sort();
  if (files.length === 0) throw new Error('src/ 下没有 .js 文件');
  return files;
}

function build() {
  const files = collect();

  let bundle = makeBanner(files) + '\n';

  for (const f of files) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    bundle += '/* ---------- ' + f + ' ' + '-'.repeat(Math.max(0, 60 - f.length)) + ' */\n';
    bundle += text;
    if (!text.endsWith('\n')) bundle += '\n';
    bundle += '\n';
  }
  return { bundle: bundle, files: files };
}

/** 语法检查：直接让 V8 编译一遍（比正则找 import/export 可靠得多）。 */
function syntaxCheck(bundle) {
  new vm.Script(bundle, { filename: 'main.js' });
}

/**
 * 铁律 1 的兜底检查：顶层不能出现 import / export。
 * 语法检查已经能抓到，但报错信息里只写 "Unexpected token"，这里再给一句人话。
 */
function checkNoModuleSyntax(bundle) {
  const bad = [];
  const lines = bundle.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*import\s/.test(l) || /^\s*export\s/.test(l)) {
      bad.push('  第 ' + (i + 1) + ' 行：' + l.trim().substring(0, 80));
    }
  }
  return bad;
}

function main() {
  const checkOnly = process.argv.indexOf('--check') >= 0;
  const { bundle, files } = build();

  try {
    syntaxCheck(bundle);
  } catch (e) {
    console.error('语法检查失败：' + e.message);
    process.exit(1);
  }

  const bad = checkNoModuleSyntax(bundle);
  if (bad.length > 0) {
    console.error('发现 import / export（宿主会直接语法错误）：');
    console.error(bad.join('\n'));
    process.exit(1);
  }

  // 顶层必须真的注册了 —— 忘了 Plugin.register 是"插件未能加载"的头号原因
  if (bundle.indexOf('Plugin.register(') < 0) {
    console.error('main.js 里没有找到 Plugin.register( —— 宿主会认为插件未注册');
    process.exit(1);
  }

  const size = Buffer.byteLength(bundle, 'utf8');
  if (checkOnly) {
    console.log('语法检查通过：' + files.length + ' 个模块，' + size + ' 字节');
    return;
  }

  fs.writeFileSync(OUT, bundle, 'utf8');
  console.log('已生成 main.js');
  console.log('  模块 ' + files.length + ' 个：' + files.join(', '));
  console.log('  大小 ' + size + ' 字节（' + (size / 1024).toFixed(1) + ' KB）');
  console.log('  行为 ' + bundle.split('\n').length + ' 行');
}

main();
