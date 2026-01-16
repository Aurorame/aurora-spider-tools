/**
 * universal-proxy.js
 * 通用的 Proxy 工具，可追蹤物件/函數的屬性存取與呼叫鏈
 *
 * 重要特點：
 *  - 起點名稱（contextName）由使用者在 new 時自行決定
 *  - 不預設為 'root' 或 'window'，完全交給使用者控制
 *  - 適合用於 window、document、特定物件、模擬物件等多種場景
 *
 * 擴展說明（轉向安全研究型）：
 *  - 新增更多 Proxy trap：construct, has, deleteProperty, defineProperty, getPrototypeOf, setPrototypeOf, preventExtensions, isExtensible
 *  - 支援「只代理函數」模式（type: 'method'），類似 dtavm
 *  - 針對 addEventListener 做特殊日誌簡化（只記錄事件類型）
 *  - 針對 console 做豁免（避免無限遞迴日誌）
 *  - 修正 apply/construct 時的 this 指向（可選綁定原始 target）
 *  - 對 Symbol 屬性更友好處理（不強制打印描述）
 *  - 日誌風格更接近 dtavm：調用者/屬性名/參數/結果
 *  - 保留原有調用鏈顯示，但更靈活
 *
 * 修改說明（本次）：
 *  - 統一輸出內容格式：所有日誌統一採用 "調用者 => [path] 操作類型 => [細節], 結果/值 => [value]" 的單行格式，確保一致性與可讀性
 *  - 在每個函數上增加詳細註釋：包括功能（特別是用于爬虫的用途，如檢測指紋腳本、攔截環境變數訪問、反偵測爬蟲行為）、原理（基於 Proxy trap 的工作機制）
 *
 * 使用示例：
 * const Universal_proxy = require('./universal-proxy');
 * const spy = new Universal_proxy(window, {
 *   contextName: 'window',
 *   type: 'object',  // 或 'method' 只代理函數
 *   logLevel: 'info'
 * });
 * spy.navigator.userAgent;  // 日誌：調用者 => [window] 獲取屬性 => [userAgent], 結果 => [...]
 */

class Universal_proxy {
  /**
   * 構造函數：初始化代理物件，並根據配置返回對應的 Proxy 實例
   *
   * 功能：
   * - 用於爬虫：初始化一個代理層，用來監控爬虫腳本對瀏覽器環境（如 window、navigator）的訪問，幫助檢測和反制指紋收集或環境探測行為
   * - 通用：合併使用者選項，決定代理類型（物件或單一函數），並啟動遞迴代理
   *
   * 原理：
   * - 基於 JavaScript Proxy 物件，透過 constructor 返回 Proxy 實例來透明代理目標物件
   * - 如果 type 為 'method'，則只代理單一函數（適合針對特定 API 如 fetch 的監控）；否則代理整個物件樹
   * - 起點路徑（startPath）由 contextName 決定，允許自定義以反映真實調用鏈（如 'window.navigator'）
   *
   * @param {any} target - 要代理的目標物件
   * @param {Object} [options={}] - 配置選項
   * @param {string} [options.contextName='obj'] - 調用鏈顯示的起點名稱
   * @param {string} [options.type='object'] - 'object' 或 'method'（只代理函數）
   * @param {boolean} [options.bindThis=false] - 是否在 apply/construct 時綁定原始 this
   */
  constructor(target, options = {}) {
    this.target = target;
    this.options = {
      logLevel: 'info',
      watchedProps: null,           // null = 全部監控，或傳入 Set/Array 指定屬性
      contextName: 'obj',           // 預設 'obj'
      type: 'object',               // 新增：'object' 或 'method'
      bindThis: false,              // 新增：是否綁定 this
      beforeGet: null,
      afterGet: null,
      beforeSet: null,
      afterSet: null,
      beforeApply: null,
      afterApply: null,
      ...options
    };

    if (Array.isArray(this.options.watchedProps)) {
      this.options.watchedProps = new Set(this.options.watchedProps);
    }

    const startPath = this.options.contextName;

    if (this.options.type === 'method' && typeof target === 'function') {
      return this.createFunctionProxy(target, startPath);
    } else {
      return this.createProxy(target, startPath);
    }
  }

  /**
   * 創建物件代理：遞迴代理目標物件，攔截各種操作
   *
   * 功能：
   * - 用於爬虫：監控爬虫腳本對物件屬性的讀寫、刪除、定義等操作，常見於檢測 canvas、webgl 等指紋收集行為，或防止爬虫修改環境變數
   * - 通用：為目標物件創建 Proxy，支援嵌套代理（物件/函數），並記錄所有 trap 操作
   *
   * 原理：
   * - 使用 Proxy 物件的 handler 定義各種 trap（如 get、set、has 等），每個 trap 都會在操作前/後執行鉤子，並記錄日誌
   * - 遞迴：當 get 返回物件時，自動包裹新 Proxy；函數則用 createFunctionProxy 處理
   * - 優化：對 console 豁免避免遞迴；只監控 watchedProps 中的屬性
   *
   * @param {any} target - 要代理的目標物件
   * @param {string} path - 當前調用鏈路徑
   * @returns {Proxy} 代理後的物件
   */
  createProxy(target, path) {
    const self = this;

    return new Proxy(target, {
      get(t, prop, receiver) {
        if (self.options.watchedProps && !self.options.watchedProps.has(prop)) {
          return Reflect.get(t, prop, receiver);
        }

        // 對 console 的豁免（避免死循環）
        if (path.includes('console')) {
          return Reflect.get(t, prop, receiver);
        }

        const fullPath = `${path}.${String(prop)}`;

        self.options.beforeGet?.(path, prop);

        let value = Reflect.get(t, prop, receiver);

        if (value && typeof value === 'object') {
          value = self.createProxy(value, fullPath);
        } else if (typeof value === 'function') {
          value = self.createFunctionProxy(value, fullPath);
        }

        const finalValue = self.options.afterGet?.(path, prop, value) ?? value;

        // Symbol 處理
        const propStr = typeof prop === 'symbol' ? prop.description ?? '[Symbol]' : prop;
        self.log(`調用者 => [${path}] 獲取屬性 => [${propStr}], 結果 => [${self.safeStringify(finalValue)}]`);

        return finalValue;
      },

      set(t, prop, value, receiver) {
        const fullPath = `${path}.${String(prop)}`;

        const newValue = self.options.beforeSet?.(path, prop, value) ?? value;

        const success = Reflect.set(t, prop, newValue, receiver);

        self.options.afterSet?.(path, prop, newValue);

        const propStr = typeof prop === 'symbol' ? prop.description ?? '[Symbol]' : prop;
        self.log(`調用者 => [${path}] 設置屬性 => [${propStr}], 值為 => [${self.safeStringify(newValue)}]`);

        return success;
      },

      // 新增 trap: has (in 操作符)
      has(t, prop) {
        const result = Reflect.has(t, prop);
        const propStr = typeof prop === 'symbol' ? prop.description ?? '[Symbol]' : prop;
        self.log(`調用者 => [${path}] in 操作符檢查屬性 => [${propStr}], 結果 => [${result}]`);
        return result;
      },

      // 新增 trap: deleteProperty
      deleteProperty(t, prop) {
        const result = Reflect.deleteProperty(t, prop);
        const propStr = typeof prop === 'symbol' ? prop.description ?? '[Symbol]' : prop;
        self.log(`調用者 => [${path}] 刪除屬性 => [${propStr}], 結果 => [${result}]`);
        return result;
      },

      // 新增 trap: defineProperty
      defineProperty(t, prop, attributes) {
        const result = Reflect.defineProperty(t, prop, attributes);
        const propStr = typeof prop === 'symbol' ? prop.description ?? '[Symbol]' : prop;
        self.log(`調用者 => [${path}] 定義屬性 => [${propStr}] 描述 => [${self.safeStringify(attributes)}], 結果 => [${result}]`);
        return result;
      },

      // 新增 trap: getPrototypeOf
      getPrototypeOf(t) {
        const result = Reflect.getPrototypeOf(t);
        self.log(`調用者 => [${path}] 獲取原型 => [], 結果 => [${self.safeStringify(result)}]`);
        return result;
      },

      // 新增 trap: setPrototypeOf
      setPrototypeOf(t, proto) {
        self.log(`調用者 => [${path}] 設置原型 => [${self.safeStringify(proto)}]`);
        return Reflect.setPrototypeOf(t, proto);
      },

      // 新增 trap: preventExtensions
      preventExtensions(t) {
        self.log(`調用者 => [${path}] 防止物件擴展 => []`);
        return Reflect.preventExtensions(t);
      },

      // 新增 trap: isExtensible
      isExtensible(t) {
        const result = Reflect.isExtensible(t);
        self.log(`調用者 => [${path}] 檢查物件是否可擴展 => [], 結果 => [${result}]`);
        return result;
      }
    });
  }

  /**
   * 創建函數代理：專門代理函數的調用與構造
   *
   * 功能：
   * - 用於爬虫：監控爬虫腳本對函數的調用（如 fetch、addEventListener），檢測 AJAX 請求或事件綁定行為，用於反爬或行為分析
   * - 通用：為函數創建 Proxy，攔截 apply（調用）和 construct（new 操作），並記錄參數與結果
   *
   * 原理：
   * - Proxy 的 apply/construct trap 用來攔截函數執行和新物件創建
   * - 可選綁定 thisArg 為原始 target，避免 this 丟失
   * - 特殊處理 addEventListener：只記錄事件類型，減少日誌噪音
   *
   * @param {Function} fn - 要代理的目標函數
   * @param {string} path - 當前調用鏈路徑
   * @returns {Proxy} 代理後的函數
   */
  createFunctionProxy(fn, path) {
    const self = this;

    return new Proxy(fn, {
      apply(target, thisArg, args) {
        // 綁定 this（如果啟用）
        if (self.options.bindThis) {
          thisArg = target;  // 類似 dtavm 的 target_obj
        }

        const finalArgs = self.options.beforeApply?.(path, args) ?? args;

        let result = Reflect.apply(target, thisArg, finalArgs);

        result = self.options.afterApply?.(path, result) ?? result;

        // 特殊處理 addEventListener
        if (fn.name === 'addEventListener') {
          self.log(`調用者 => [${path}] 調用函數 => [${fn.name}], 傳參 => [${finalArgs[0]}], 結果 => [${self.safeStringify(result)}]`);
        } else {
          self.log(`調用者 => [${path}] 調用函數 => [${fn.name}], 傳參 => [${self.safeStringify(finalArgs)}], 結果 => [${self.safeStringify(result)}]`);
        }

        return result;
      },

      // 新增 trap: construct
      construct(target, args, newTarget) {
        const finalArgs = args;  // 可在此加 beforeConstruct 鉤子，如果需要

        const result = Reflect.construct(target, finalArgs, newTarget);

        self.log(`調用者 => [${path}] 構造物件 => [${target.name}], 傳參 => [${self.safeStringify(finalArgs)}], 結果 => [${self.safeStringify(result)}]`);

        return result;
      }
    });
  }

/**
 * 极简、高隐蔽性的 safeStringify 函数
 * 目标：在尽可能不暴露代理存在的前提下，将任意值转为字符串用于日志
 *
 * 设计原则（2026年反检测优先级最高方案）：
 * 1. 行为与原生 JSON.stringify 尽可能一致
 * 2. 不捕获任何异常，让异常自然抛出（这是当前最难被检测的做法）
 * 3. 尽量减少“人为干预”的痕迹，避免返回任何固定伪造字符串（如 '[Object]'、'[Circular]'）
 * 4. 只对最基本的边缘情况做最轻量处理，其他全部交给原生 JSON.stringify
 *
 * 适用场景：
 *   - 需要最高级别反代理检测（指纹对抗、环境模拟、爬虫伪装）
 *   - 愿意接受日志偶尔因序列化失败而中断或显示异常信息
 *   - 外层调用处已做好异常捕获准备（推荐在 log 方法中包裹 try-catch）
 */
  safeStringify(value) {
    // 第一层判断：处理 null 和 undefined
    // 原生 JSON.stringify(null) → "null"
    // 原生 JSON.stringify(undefined) → undefined（但在字符串上下文中常被忽略）
    // 这里统一返回字符串形式，与大多数日志场景更友好，且原生行为一致
    if (value == null) {
        return String(value);  // "null" 或 "undefined"
    }

    // 第二层判断：如果是对象（包括数组、普通对象、Date、RegExp 等）
    // 核心策略：直接交给原生 JSON.stringify 处理，不加任何 try-catch
    // 原因：
    //   1. 现代指纹脚本最常见的检测方式之一就是观察 JSON.stringify 的异常行为
    //      - 循环引用 → "Converting circular structure to JSON"
    //      - 包含函数 → "TypeError: Converting circular structure..."
    //      - 包含 Symbol → "TypeError: Cannot stringify a Symbol"
    //      - BigInt → "TypeError: Do not know how to serialize a BigInt"
    //   2. 如果我们在这里捕获异常并返回自定义字符串（如 '[Object]'），
    //      就会与原生对象行为产生明显差异 → 极易被检测到代理存在
    //   3. 不捕获异常是最接近原生对象的做法，指纹脚本很难区分这是代理还是真实对象
    //
    // 缺点：
    //   - 如果 value 包含不可序列化内容，函数会直接抛出异常
    //   - 调用方必须在外层捕获异常，否则日志记录会中断
    //   - 但这正是我们想要的“真实行为”
    if (typeof value === 'object') {
        // 让它自然抛错，大部分真实环境也是这样
        // 这里不做任何防护，就是故意让异常透传出去
        return JSON.stringify(value);
    }

    // 第三层：非 null、非对象、非函数的原始类型
    // 包括：string, number, boolean, bigint, symbol
    // 原生 JSON.stringify 对这些类型的处理：
    //   - string/number/boolean → 直接带引号/不带引号的字符串形式
    //   - bigint/symbol → 会抛 TypeError
    //
    // 但这里我们选择统一用 String() 处理：
    //   - 避免 BigInt 和 Symbol 抛错（减少日志中断）
    //   - String(BigInt) → "12345678901234567890"
    //   - String(Symbol) → "Symbol(...)"
    //   - 这种处理在很多真实场景中也存在（console.log、模板字符串等）
    //   - 虽然与严格的 JSON.stringify 不完全一致，但差异较小，且不会引入“捕获异常返回假字符串”这种高危行为
    //
    // 权衡说明：
    //   如果追求100%与 JSON.stringify 一致，可以在这里也让 BigInt/Symbol 抛错：
    //      return JSON.stringify(value);
    //   但那样日志中断会更频繁，实际使用中通常不划算
    //   当前做法是“实用性与隐蔽性的折中”
    return String(value);
  }

  /**
   * 日誌記錄：統一輸出日誌到控制台或自定義函數
   *
   * 功能：
   * - 用於爬虫：記錄所有攔截操作的詳細日誌，用於分析爬虫腳本的環境探測或 API 調用模式，幫助優化反爬策略
   * - 通用：根據 logLevel 輸出單行日誌，支持自定義輸出（如發送到服務器）
   *
   * 原理：
   * - 使用 console[level] 動態調用，或 fallback 到 console.log
   * - 統一格式：所有日誌拼接為單行，確保解析工具（如日誌分析器）易處理
   *
   * @param {...any} messages - 要記錄的消息
   */
  log(...messages) {
    const level = this.options.logLevel;
    const line = messages.join(' ');

    if (typeof level === 'function') {
      level(line);
    } else {
      (console[level] || console.log)(line);
    }
  }
}

module.exports = Universal_proxy;