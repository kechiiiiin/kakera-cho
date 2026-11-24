// iOS アプリの「かたち・日記・ことば・かたちにする」（WKWebView の中）で Web 版の App.tsx をまるごと動かす入口。
// 設計: jinsei vault hestia/projects/blog-cms-design/かけら帳iOS構想.md §3.3
//
// 束ね方: `npm run build:ios-app`（esbuild で ios/App/EditorWeb/kapp.js・kapp.css に1本ずつ）。アプリに同梱する。
// 初めの画面は URL の hash で受け取る（kakera-editor://app/kapp.html#katachi）。無い・知らない値ならかけら（Web と同じ）。
//
// 通信: App が叩く相対パスの /api/* は kakera-editor://app/api/* になり、Swift の WKURLSchemeHandler（ios/App/AppWebView.swift）が
// 本番のかけら帳へサービストークンをつけて中継する。⚠️ 秘密はこの JS に一切渡さない（ここから読めるものは無い）。
// 顔の検出（MediaPipe）は Web と同じく CDN（jsdelivr・storage.googleapis.com）から読む。

import { render } from 'preact';
import App, { START_VIEWS, type StartView } from '../../src/components/App';
import '../../src/styles/app.css';
import './app.css';

function startOf(hash: string): StartView {
  const v = hash.replace(/^#/, '');
  return (START_VIEWS as readonly string[]).includes(v) ? (v as StartView) : 'write';
}

render(<App start={startOf(location.hash)} />, document.getElementById('frame')!);
