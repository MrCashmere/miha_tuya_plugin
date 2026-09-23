/* ============================================================================
 * §0  通用小工具
 *
 * 这个文件排在 `src/` 的最前面（构建脚本按文件名排序拼接），所以这里定义的
 * 函数对所有模块可见。
 *
 * ## 为什么需要 `isArray()` 而不是 `x instanceof Array`
 *
 * 沙箱里跑着不止一个 realm：插件自己的代码是一个 realm，而某些桥调用
 * （`JSON.parse` 的结果、宿主推回来的对象）可能来自另一个。`instanceof`
 * 是**跨 realm 不可靠**的 —— `[] instanceof Array` 在别的 realm 里就是 false，
 * 于是「明明传进来一个数组，代码却当它不是数组」，静默走空分支。
 *
 * 这类 bug 的麻烦之处在于：**它不抛错**，只是功能整个消失。
 * 所以凡是判断数组/对象的地方，一律走这里的工具函数。
 * ========================================================================== */

/** 是不是数组（跨 realm 安全）。 */
function isArray(x) {
  return Object.prototype.toString.call(x) === '[object Array]';
}

/** 是不是普通对象（跨 realm 安全；数组、null、函数都不算）。 */
function isPlainObject(x) {
  if (x === null || typeof x !== 'object') return false;
  return Object.prototype.toString.call(x) === '[object Object]';
}

/** 取数组；不是数组就给空数组。避免满屏的三元表达式。 */
function asArray(x) {
  if (isArray(x)) return x;
  if (x === undefined || x === null) return [];
  return [x];
}

/** 字符串取值 + 去空白；null/undefined 变成空串。 */
function strOf(x) {
  if (x === undefined || x === null) return '';
  return String(x).trim();
}

/** 数字取值；转不出来或 NaN 时用默认值。 */
function numOr(x, fallback) {
  const n = Number(x);
  if (isNaN(n) || !isFinite(n)) return fallback;
  return n;
}

/** 夹取整数到 [lo, hi]。 */
function clamp(n, lo, hi) {
  const v = numOr(n, lo);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** 极简日志：宿主日志不可用时吞掉异常，绝不因为打日志把主流程弄挂。 */
function safeLog(level, tag, msg) {
  try {
    if (Host && Host.log && typeof Host.log[level] === 'function') {
      const p = Host.log[level](tag, msg);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
  } catch (e) {
    // 日志失败不影响业务
  }
}
