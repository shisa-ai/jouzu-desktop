/**
 * The words of the chat window that say what failed or what is going on, in
 * every interface language. Errors are localized here from the host's `code`
 * and parameters; the host's original text is only ever shown under Details.
 */
import { createContext, useContext } from "react";
import type { Locale } from "./i18n";

const en = {
  details: "Details",
  hideDetails: "Hide details",
  dismiss: "Dismiss",
  retry: "Retry",
  discard: "Discard",
  continue: "Continue",
  newSession: "New session",
  restartSession: "Restart session",
  removeImages: "Remove images",
  clearFlowHistory: "Clear Flow history",
  showFile: "Show file",
  // The session ended (the one thing that ever takes the composer's place).
  failureDefault: "This session stopped because of an error.",
  failureRuntimeCrashed: "This session's runtime stopped and could not recover.",
  failureAttach: "The runtime could not open this session.",
  failureSwitchCancelled: "The runtime refused to open this session.",
  failureRuntimeUnavailable: "The runtime could not start.",
  failureRuntimeError: "The runtime ended this session with an error.",
  openFailed: "This session could not be opened.",
  newSessionFailed: "A new session could not be started.",
  noImages: "This conversation has no images in its history.",
  imagesFailed: "The images were not removed.",
  // The conversation.
  notSent: "Not sent",
  sending: "Sending…",
  noReply: "No reply",
  replyFailed: "This reply stopped with an error",
  failed: "Failed",
  interrupted: "Interrupted",
  historyFailed: "The conversation could not be loaded.",
  extension: "Extension",
  extensionFailed: "An extension failed.",
  attachFailed: "The images were not attached.",
  sessionEnded: "Session ended",
  flowHolding: "Flow is holding the last message.",
  release: "Release",
  resume: "Resume",
  turnOffFlow: "Turn off Flow",
  textguardAlert: "TextGuard withheld content.",
  turnOffTextGuard: "Turn off TextGuard",
  images: "{n} image(s)",
  // The header.
  reconnecting: "Reconnecting…",
  starting: "Starting…",
  // Results shown at the control that ran them.
  modelFailed: "The model was not changed.",
  modelsFailed: "The models could not be listed.",
  thinkingFailed: "The thinking level was not changed.",
  stopFailed: "Stop did not take effect.",
  compactFailed: "The conversation was not compacted.",
  compacted: "Earlier conversation compacted.",
  exportFailed: "The conversation was not exported.",
  exported: "Conversation exported.",
  reloadFailed: "The session was not reloaded.",
  flowFailed: "The Flow command did not run.",
  textguardFailed: "TextGuard was not changed.",
  branchFailed: "The conversation was not branched.",
  queueFailed: "The queue was not changed.",
  sendOpening: "The session is still opening. Your message is still here.",
  sendLoadingModel: "The model is still loading. Your message is still here.",
  sendNoModel: "This session has no model. Your message is still here.",
  recovered: "Recovered the session without the interrupted tool call.",
  sessionUpdateFailed: "The session was not updated.",
  copyIdFailed: "The session ID was not copied.",
  warmFailed: "The runtime for this folder could not start.",
  // The queue above the composer.
  queueReturned: "{n} waiting after the stopped reply.",
  queueNext: "Jouzu reads these at its next step.",
  heldByFlow: "Held by Flow",
  // Host error codes.
  codeRuntimeUnavailable: "The runtime is not available right now.",
  codeRuntimeTimeout: "The runtime did not respond in time.",
  codeSessionNotFound: "This session is no longer open.",
  codeSessionStopped: "This session has stopped.",
  codeUnauthorized: "This window lost its connection to Jouzu. Reload the app.",
  codeForbidden: "This window is not allowed to do that. Reload the app.",
  codePromptResolved: "This request was already answered.",
  codePromptExpired: "This request expired before it was answered.",
  codeNoModel: "This session has no model.",
  codeModelUnavailable: "The runtime does not offer that model.",
  codeMessageHeld: "Flow control is holding this message.",
  codeNetwork: "Cannot reach Jouzu. Check that the app is still running.",
};
export type ChatText = typeof en;

const ja: ChatText = {
  details: "詳細",
  hideDetails: "詳細を隠す",
  dismiss: "閉じる",
  retry: "再試行",
  discard: "破棄",
  continue: "続ける",
  newSession: "新しいセッション",
  restartSession: "セッションを再起動",
  removeImages: "画像を削除",
  clearFlowHistory: "Flow 履歴を消去",
  showFile: "ファイルを表示",
  failureDefault: "エラーのためこのセッションは停止しました。",
  failureRuntimeCrashed: "このセッションのランタイムが停止し、回復できませんでした。",
  failureAttach: "ランタイムがこのセッションを開けませんでした。",
  failureSwitchCancelled: "ランタイムがこのセッションを開くことを拒否しました。",
  failureRuntimeUnavailable: "ランタイムを起動できませんでした。",
  failureRuntimeError: "ランタイムがエラーでこのセッションを終了しました。",
  openFailed: "このセッションを開けませんでした。",
  newSessionFailed: "新しいセッションを開始できませんでした。",
  noImages: "この会話の履歴に画像はありません。",
  imagesFailed: "画像は削除されませんでした。",
  notSent: "未送信",
  sending: "送信中…",
  noReply: "応答なし",
  replyFailed: "この応答はエラーで止まりました",
  failed: "失敗",
  interrupted: "中断",
  historyFailed: "会話を読み込めませんでした。",
  extension: "拡張機能",
  extensionFailed: "拡張機能でエラーが発生しました。",
  attachFailed: "画像は添付されませんでした。",
  sessionEnded: "セッション終了",
  flowHolding: "Flow が最後のメッセージを保留しています。",
  release: "解放",
  resume: "再開",
  turnOffFlow: "Flow をオフ",
  textguardAlert: "TextGuard がコンテンツを差し止めました。",
  turnOffTextGuard: "TextGuard をオフ",
  images: "画像 {n} 枚",
  reconnecting: "再接続中…",
  starting: "起動中…",
  modelFailed: "モデルは変更されませんでした。",
  modelsFailed: "モデル一覧を取得できませんでした。",
  thinkingFailed: "思考レベルは変更されませんでした。",
  stopFailed: "停止できませんでした。",
  compactFailed: "会話は圧縮されませんでした。",
  compacted: "以前の会話を圧縮しました。",
  exportFailed: "会話はエクスポートされませんでした。",
  exported: "会話をエクスポートしました。",
  reloadFailed: "セッションは再読み込みされませんでした。",
  flowFailed: "Flow コマンドは実行されませんでした。",
  textguardFailed: "TextGuard は変更されませんでした。",
  branchFailed: "会話は分岐されませんでした。",
  queueFailed: "キューは変更されませんでした。",
  sendOpening: "セッションを開いています。メッセージはそのまま残っています。",
  sendLoadingModel: "モデルを読み込み中です。メッセージはそのまま残っています。",
  sendNoModel: "このセッションにはモデルがありません。メッセージはそのまま残っています。",
  recovered: "中断したツール呼び出しを除いてセッションを回復しました。",
  sessionUpdateFailed: "セッションは更新されませんでした。",
  copyIdFailed: "セッション ID はコピーされませんでした。",
  warmFailed: "このフォルダーのランタイムを起動できませんでした。",
  queueReturned: "停止した応答の後に {n} 件が待っています。",
  queueNext: "Jouzu は次のステップでこれを読みます。",
  heldByFlow: "Flow が保留中",
  codeRuntimeUnavailable: "ランタイムは現在利用できません。",
  codeRuntimeTimeout: "ランタイムが時間内に応答しませんでした。",
  codeSessionNotFound: "このセッションはもう開いていません。",
  codeSessionStopped: "このセッションは停止しています。",
  codeUnauthorized: "このウィンドウは Jouzu との接続を失いました。アプリを再読み込みしてください。",
  codeForbidden: "このウィンドウではその操作はできません。アプリを再読み込みしてください。",
  codePromptResolved: "このリクエストはすでに回答済みです。",
  codePromptExpired: "このリクエストは回答前に期限切れになりました。",
  codeNoModel: "このセッションにはモデルがありません。",
  codeModelUnavailable: "ランタイムはそのモデルを提供していません。",
  codeMessageHeld: "Flow コントロールがこのメッセージを保留しています。",
  codeNetwork: "Jouzu に接続できません。アプリが動作しているか確認してください。",
};

const hans: ChatText = {
  details: "详情",
  hideDetails: "隐藏详情",
  dismiss: "关闭",
  retry: "重试",
  discard: "丢弃",
  continue: "继续",
  newSession: "新会话",
  restartSession: "重启会话",
  removeImages: "移除图片",
  clearFlowHistory: "清空 Flow 历史",
  showFile: "显示文件",
  failureDefault: "此会话因错误而停止。",
  failureRuntimeCrashed: "此会话的运行环境已停止，且无法恢复。",
  failureAttach: "运行环境无法打开此会话。",
  failureSwitchCancelled: "运行环境拒绝打开此会话。",
  failureRuntimeUnavailable: "运行环境无法启动。",
  failureRuntimeError: "运行环境因错误结束了此会话。",
  openFailed: "无法打开此会话。",
  newSessionFailed: "无法开始新会话。",
  noImages: "此对话的历史中没有图片。",
  imagesFailed: "图片未移除。",
  notSent: "未发送",
  sending: "发送中…",
  noReply: "没有回复",
  replyFailed: "此回复因错误而停止",
  failed: "失败",
  interrupted: "已中断",
  historyFailed: "无法加载对话。",
  extension: "扩展",
  extensionFailed: "扩展出错。",
  attachFailed: "图片未添加。",
  sessionEnded: "会话已结束",
  flowHolding: "Flow 正在暂扣最后一条消息。",
  release: "放行",
  resume: "恢复",
  turnOffFlow: "关闭 Flow",
  textguardAlert: "TextGuard 拦下了内容。",
  turnOffTextGuard: "关闭 TextGuard",
  images: "{n} 张图片",
  reconnecting: "正在重新连接…",
  starting: "正在启动…",
  modelFailed: "模型未更改。",
  modelsFailed: "无法获取模型列表。",
  thinkingFailed: "思考级别未更改。",
  stopFailed: "停止未生效。",
  compactFailed: "对话未压缩。",
  compacted: "已压缩较早的对话。",
  exportFailed: "对话未导出。",
  exported: "对话已导出。",
  reloadFailed: "会话未重新加载。",
  flowFailed: "Flow 命令未执行。",
  textguardFailed: "TextGuard 未更改。",
  branchFailed: "未能创建分支。",
  queueFailed: "队列未更改。",
  sendOpening: "会话仍在打开中。你的消息还在输入框中。",
  sendLoadingModel: "模型仍在加载。你的消息还在输入框中。",
  sendNoModel: "此会话没有模型。你的消息还在输入框中。",
  recovered: "已恢复会话，去掉了被中断的工具调用。",
  sessionUpdateFailed: "会话未更新。",
  copyIdFailed: "会话 ID 未复制。",
  warmFailed: "此文件夹的运行环境无法启动。",
  queueReturned: "停止的回复之后有 {n} 条在等待。",
  queueNext: "Jouzu 会在下一步读取这些消息。",
  heldByFlow: "Flow 暂扣中",
  codeRuntimeUnavailable: "运行环境暂时不可用。",
  codeRuntimeTimeout: "运行环境未在规定时间内响应。",
  codeSessionNotFound: "此会话已关闭。",
  codeSessionStopped: "此会话已停止。",
  codeUnauthorized: "此窗口与 Jouzu 的连接已断开。请重新加载应用。",
  codeForbidden: "此窗口不允许执行该操作。请重新加载应用。",
  codePromptResolved: "此请求已被回答。",
  codePromptExpired: "此请求在回答前已过期。",
  codeNoModel: "此会话没有模型。",
  codeModelUnavailable: "运行环境不提供该模型。",
  codeMessageHeld: "Flow 控制正在暂扣此消息。",
  codeNetwork: "无法连接 Jouzu。请确认应用仍在运行。",
};

const hant: ChatText = {
  details: "詳細資訊",
  hideDetails: "隱藏詳細資訊",
  dismiss: "關閉",
  retry: "重試",
  discard: "捨棄",
  continue: "繼續",
  newSession: "新工作階段",
  restartSession: "重新啟動工作階段",
  removeImages: "移除圖片",
  clearFlowHistory: "清除 Flow 歷史",
  showFile: "顯示檔案",
  failureDefault: "此工作階段因錯誤而停止。",
  failureRuntimeCrashed: "此工作階段的執行環境已停止，且無法恢復。",
  failureAttach: "執行環境無法開啟此工作階段。",
  failureSwitchCancelled: "執行環境拒絕開啟此工作階段。",
  failureRuntimeUnavailable: "執行環境無法啟動。",
  failureRuntimeError: "執行環境因錯誤結束了此工作階段。",
  openFailed: "無法開啟此工作階段。",
  newSessionFailed: "無法開始新工作階段。",
  noImages: "此對話的歷史中沒有圖片。",
  imagesFailed: "圖片未移除。",
  notSent: "未傳送",
  sending: "傳送中…",
  noReply: "沒有回覆",
  replyFailed: "此回覆因錯誤而停止",
  failed: "失敗",
  interrupted: "已中斷",
  historyFailed: "無法載入對話。",
  extension: "擴充功能",
  extensionFailed: "擴充功能出錯。",
  attachFailed: "圖片未加入。",
  sessionEnded: "工作階段已結束",
  flowHolding: "Flow 正在暫扣最後一則訊息。",
  release: "放行",
  resume: "恢復",
  turnOffFlow: "關閉 Flow",
  textguardAlert: "TextGuard 攔下了內容。",
  turnOffTextGuard: "關閉 TextGuard",
  images: "{n} 張圖片",
  reconnecting: "正在重新連線…",
  starting: "正在啟動…",
  modelFailed: "模型未變更。",
  modelsFailed: "無法取得模型清單。",
  thinkingFailed: "思考層級未變更。",
  stopFailed: "停止未生效。",
  compactFailed: "對話未壓縮。",
  compacted: "已壓縮較早的對話。",
  exportFailed: "對話未匯出。",
  exported: "對話已匯出。",
  reloadFailed: "工作階段未重新載入。",
  flowFailed: "Flow 指令未執行。",
  textguardFailed: "TextGuard 未變更。",
  branchFailed: "未能建立分支。",
  queueFailed: "佇列未變更。",
  sendOpening: "工作階段仍在開啟中。你的訊息還在輸入框中。",
  sendLoadingModel: "模型仍在載入。你的訊息還在輸入框中。",
  sendNoModel: "此工作階段沒有模型。你的訊息還在輸入框中。",
  recovered: "已恢復工作階段，去掉了被中斷的工具呼叫。",
  sessionUpdateFailed: "工作階段未更新。",
  copyIdFailed: "工作階段 ID 未複製。",
  warmFailed: "此資料夾的執行環境無法啟動。",
  queueReturned: "停止的回覆之後有 {n} 則在等待。",
  queueNext: "Jouzu 會在下一步讀取這些訊息。",
  heldByFlow: "Flow 暫扣中",
  codeRuntimeUnavailable: "執行環境暫時無法使用。",
  codeRuntimeTimeout: "執行環境未在時限內回應。",
  codeSessionNotFound: "此工作階段已關閉。",
  codeSessionStopped: "此工作階段已停止。",
  codeUnauthorized: "此視窗與 Jouzu 的連線已中斷。請重新載入應用程式。",
  codeForbidden: "此視窗不允許執行該操作。請重新載入應用程式。",
  codePromptResolved: "此請求已被回答。",
  codePromptExpired: "此請求在回答前已過期。",
  codeNoModel: "此工作階段沒有模型。",
  codeModelUnavailable: "執行環境不提供該模型。",
  codeMessageHeld: "Flow 控制正在暫扣此訊息。",
  codeNetwork: "無法連線到 Jouzu。請確認應用程式仍在執行。",
};

export const chatTexts: Record<Locale, ChatText> = { en, ja, "zh-Hans": hans, "zh-Hant": hant };

const ChatTextContext = createContext<ChatText>(en);
export const ChatTextProvider = ChatTextContext.Provider;
/** The chat's words in the interface language. */
export function useChatText(): ChatText { return useContext(ChatTextContext); }

export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => name in params ? String(params[name]) : whole);
}

type TextKey = keyof ChatText;

/** Host error codes with a sentence of their own. */
const CODES: Partial<Record<string, TextKey>> = {
  "runtime-unavailable": "codeRuntimeUnavailable",
  "runtime-timeout": "codeRuntimeTimeout",
  "session-not-found": "codeSessionNotFound",
  "session-stopped": "codeSessionStopped",
  unauthorized: "codeUnauthorized",
  forbidden: "codeForbidden",
  "prompt-forbidden": "codeForbidden",
  "prompt-resolved": "codePromptResolved",
  "prompt-expired": "codePromptExpired",
  "no-model": "codeNoModel",
  "model-unavailable": "codeModelUnavailable",
  "message-held": "codeMessageHeld",
};

/** Why a session ended, from the host's `failure.code`. */
const FAILURES: Partial<Record<string, TextKey>> = {
  "runtime-crashed": "failureRuntimeCrashed",
  "session-attach-failed": "failureAttach",
  "session-switch-cancelled": "failureSwitchCancelled",
  "runtime-unavailable": "failureRuntimeUnavailable",
  "runtime-error": "failureRuntimeError",
};

/** A host error code's sentence, when it has one of its own. */
export function codeText(t: ChatText, code: string): string | undefined {
  const key = CODES[code];
  return key ? t[key] : undefined;
}

export function failureText(t: ChatText, code: string | undefined): string {
  const key = code ? FAILURES[code] : undefined;
  return t[key ?? "failureDefault"];
}

/** A result to show at a control: localized words, and the original text kept for Details. */
export interface Explained { text: string; details?: string }

function rawText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  return raw.replace(/^(?:Api)?Error:\s*/u, "").trim();
}

/**
 * A failed request in the interface language. A host error with a known code
 * gets that code's sentence; anything else says what did not happen (`failed`).
 * The original text is never translated and only ever goes under Details.
 */
export function explain(t: ChatText, error: unknown, failed: string): Explained {
  const raw = rawText(error);
  const details = raw && raw !== failed ? raw : undefined;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const known = typeof code === "string" ? CODES[code] : undefined;
  if (known) return { text: t[known], details };
  if (error instanceof TypeError && /fetch|network/iu.test(error.message)) return { text: t.codeNetwork, details };
  return { text: failed, details };
}
