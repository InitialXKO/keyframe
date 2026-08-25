window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  if (event.data && event.data.source === "keyframe-engine-devtools") {
    chrome.runtime.sendMessage(event.data);
  }
}, false);
