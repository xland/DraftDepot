// 站点脚本（JS/*.js）共用的 IPC 客户端，注入时挂在 window.DDMsg 上。
// 与主页面 UI/src/Msg.ts 是同一套协议：{ id, method, args } 发出去，native 回 { id, result | error }。
// 由 PageSite::injectSiteScript 拼在站点脚本前面，所以站点脚本里直接用 DDMsg.invoke 即可。
//
// 本文件只管 JS ↔ C++ 这一层。原先挂在这里的两块都各自挪出去了：
//   DDImages（JS/Images.js）：取图片文件、传图床、把图床地址换回正文
//   DDMask（JS/Mask.js）：同步文章期间的整页遮罩与提示
// 它们一个是业务、一个是 UI，留在这里会让"改通信协议"与"改业务"这两件事互相牵扯。
(function () {
  const cache = new Map(); // id → { resolve, reject, withObjects }；事件名 → 监听者数组，与主页面一致共用一张表

  function emit(eventName, data) {
    const listeners = cache.get(eventName);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener(data);
    }
  }

  function onMessage(event) {
    const msg = event.data;
    if (msg.id && cache.has(msg.id)) {
      const item = cache.get(msg.id);
      if (msg.error) {
        item.reject(msg.error);
      } else {
        // withObjects 的请求额外把原生随回包附带的附加对象交出去（没有时给空数组）
        item.resolve(
          item.withObjects ? { result: msg.result, objects: event.additionalObjects || [] } : msg.result,
        );
      }
      cache.delete(msg.id);
    } else if (msg.eventName) {
      emit(msg.eventName, msg);
    }
  }

  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener("message", onMessage);
  }

  function invoke(method, args, withObjects) {
    return new Promise(function (resolve, reject) {
      const id = Math.random().toString(8).substring(2);
      cache.set(id, { resolve: resolve, reject: reject, withObjects: withObjects });
      if (!window.chrome || !window.chrome.webview) {
        return;
      }
      window.chrome.webview.postMessage({ id: id, method: method, args: args });
    });
  }

  /**
   * 与 invoke 同构，但回包 resolve 的是 { result, objects }：
   * objects 是原生用 PostWebMessageAsJsonWithAdditionalObjects 随回包附带的对象数组
   * （如 File System Access 的文件句柄），原生没附带对象时是空数组
   */
  function invokeWithObjects(method, args) {
    return invoke(method, args, true);
  }

  function on(eventName, listener) {
    const arr = cache.get(eventName);
    if (arr) {
      arr.push(listener);
    } else {
      cache.set(eventName, [listener]);
    }
  }

  function off(eventName, listener) {
    const arr = cache.get(eventName);
    if (!arr) return;
    cache.set(
      eventName,
      arr.filter(function (item) {
        return item !== listener;
      }),
    );
  }

  function once(eventName, listener) {
    const onceListener = function (arg) {
      listener(arg);
      off(eventName, onceListener);
    };
    on(eventName, onceListener);
  }

  window.DDMsg = {
    invoke: invoke,
    invokeWithObjects: invokeWithObjects,
    on: on,
    off: off,
    once: once,
    emit: emit,
  };
})();
