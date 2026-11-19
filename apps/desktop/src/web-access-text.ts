import type { Locale } from "./i18n";

/** The Web access card's words, in every interface language. */
export interface Text {
  title: string; hint: string; scope: string;
  off: string; local: string; networks: string;
  offHint: string; localHint: string; networksHint: string;
  trusted: string; lan: string; tailnet: string; noNetworks: string; unavailable: string;
  save: string; serving: string; notServing: string;
  plainLan: string;
  pair: string; pairHint: string; code: string; expires: string; copy: string; copied: string; open: string; cancel: string; done: string;
  devices: string; noDevices: string; lastSeen: string; never: string; remove: string; removeAll: string;
  confirmRemoveAll: string; failed: string;
}

export const webAccessText: Record<Locale, Text> = {
  en: {
    title: "Web access", hint: "Use Jouzu from a browser on this computer, or from another device on a network you trust. Every browser must be paired with this app first.", scope: "Who can connect",
    off: "Off", local: "This computer only", networks: "This computer and trusted networks",
    offHint: "Only this window uses Jouzu. Browsers and other devices cannot connect.", localHint: "A paired browser on this computer can connect. Other devices are refused.", networksHint: "Paired devices on the networks you turn on below can connect. Everything else is refused.",
    trusted: "Trusted networks", lan: "Local network", tailnet: "Tailscale", noNetworks: "No private network was found on this computer.", unavailable: "Turned on but not connected now:",
    save: "Save", serving: "Serving at", notServing: "Could not start on",
    plainLan: "Traffic on a local network is not encrypted. Use it only on networks you control. Tailscale traffic is encrypted.",
    pair: "Pair a device", pairHint: "Open the link or scan the code on the device you want to pair, or open the address there and type the code. The code works once and expires in", code: "Pairing code", expires: "minutes", copy: "Copy link", copied: "Copied", open: "Open in browser", cancel: "Cancel", done: "Paired",
    devices: "Paired devices", noDevices: "No device is paired yet.", lastSeen: "Last seen", never: "never", remove: "Remove", removeAll: "Remove all",
    confirmRemoveAll: "Remove every paired device? Each one has to be paired again to connect.", failed: "The web access change did not complete.",
  },
  ja: {
    title: "Web アクセス", hint: "このコンピューターのブラウザー、または信頼できるネットワーク上の別のデバイスから Jouzu を使えます。どのブラウザーも、先にこのアプリとのペアリングが必要です。", scope: "接続できる範囲",
    off: "オフ", local: "このコンピューターのみ", networks: "このコンピューターと信頼できるネットワーク",
    offHint: "Jouzu を使えるのはこのウィンドウだけです。ブラウザーや他のデバイスからは接続できません。", localHint: "このコンピューター上のペアリング済みブラウザーが接続できます。他のデバイスは拒否されます。", networksHint: "下でオンにしたネットワーク上のペアリング済みデバイスが接続できます。それ以外は拒否されます。",
    trusted: "信頼できるネットワーク", lan: "ローカルネットワーク", tailnet: "Tailscale", noNetworks: "このコンピューターにプライベートネットワークが見つかりません。", unavailable: "オンにしているが現在つながっていないもの:",
    save: "保存", serving: "公開中のアドレス", notServing: "開始できませんでした:",
    plainLan: "ローカルネットワーク上の通信は暗号化されません。自分で管理しているネットワークでのみ使ってください。Tailscale の通信は暗号化されます。",
    pair: "デバイスをペアリング", pairHint: "ペアリングするデバイスでリンクを開くかコードを読み取るか、アドレスを開いてコードを入力してください。コードは 1 回だけ使え、有効期限は", code: "ペアリングコード", expires: "分です", copy: "リンクをコピー", copied: "コピーしました", open: "ブラウザーで開く", cancel: "キャンセル", done: "ペアリングしました",
    devices: "ペアリング済みデバイス", noDevices: "ペアリング済みのデバイスはありません。", lastSeen: "最終接続", never: "なし", remove: "削除", removeAll: "すべて削除",
    confirmRemoveAll: "ペアリング済みのデバイスをすべて削除しますか？ 接続するには再度ペアリングが必要です。", failed: "Web アクセスの変更を完了できませんでした。",
  },
  "zh-Hans": {
    title: "Web 访问", hint: "可以在这台电脑的浏览器里，或在可信网络上的其他设备上使用 Jouzu。每个浏览器都要先和本应用配对。", scope: "允许谁连接",
    off: "关闭", local: "仅这台电脑", networks: "这台电脑和可信网络",
    offHint: "只有这个窗口能使用 Jouzu，浏览器和其他设备都无法连接。", localHint: "这台电脑上已配对的浏览器可以连接，其他设备会被拒绝。", networksHint: "下面开启的网络上已配对的设备可以连接，其他一律拒绝。",
    trusted: "可信网络", lan: "局域网", tailnet: "Tailscale", noNetworks: "这台电脑上没有找到私有网络。", unavailable: "已开启但当前未连接：",
    save: "保存", serving: "正在提供服务的地址", notServing: "无法启动：",
    plainLan: "局域网上的通信未加密，请只在你自己管理的网络上使用。Tailscale 的通信是加密的。",
    pair: "配对设备", pairHint: "在要配对的设备上打开链接或扫描二维码，或者打开地址后输入配对码。配对码只能用一次，有效期", code: "配对码", expires: "分钟", copy: "复制链接", copied: "已复制", open: "在浏览器中打开", cancel: "取消", done: "已配对",
    devices: "已配对设备", noDevices: "还没有配对的设备。", lastSeen: "最近连接", never: "从未", remove: "移除", removeAll: "全部移除",
    confirmRemoveAll: "移除所有已配对设备？之后每台设备都要重新配对才能连接。", failed: "Web 访问的更改没有完成。",
  },
  "zh-Hant": {
    title: "Web 存取", hint: "可以在這台電腦的瀏覽器中，或在可信網路上的其他裝置上使用 Jouzu。每個瀏覽器都要先與本應用程式配對。", scope: "允許誰連線",
    off: "關閉", local: "僅這台電腦", networks: "這台電腦與可信網路",
    offHint: "只有這個視窗能使用 Jouzu，瀏覽器與其他裝置都無法連線。", localHint: "這台電腦上已配對的瀏覽器可以連線，其他裝置會被拒絕。", networksHint: "下方開啟的網路上已配對的裝置可以連線，其他一律拒絕。",
    trusted: "可信網路", lan: "區域網路", tailnet: "Tailscale", noNetworks: "這台電腦上沒有找到私人網路。", unavailable: "已開啟但目前未連線：",
    save: "儲存", serving: "正在提供服務的位址", notServing: "無法啟動：",
    plainLan: "區域網路上的通訊未加密，請只在你自己管理的網路上使用。Tailscale 的通訊是加密的。",
    pair: "配對裝置", pairHint: "在要配對的裝置上開啟連結或掃描 QR 碼，或開啟位址後輸入配對碼。配對碼只能使用一次，有效期", code: "配對碼", expires: "分鐘", copy: "複製連結", copied: "已複製", open: "在瀏覽器中開啟", cancel: "取消", done: "已配對",
    devices: "已配對裝置", noDevices: "尚無已配對的裝置。", lastSeen: "最近連線", never: "從未", remove: "移除", removeAll: "全部移除",
    confirmRemoveAll: "移除所有已配對裝置？之後每台裝置都要重新配對才能連線。", failed: "Web 存取的變更沒有完成。",
  },
};
