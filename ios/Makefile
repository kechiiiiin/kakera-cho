# かけら帳（kakera-cho）iOS — よく使う手順（便り tayori/ios と同じ組み立て）
#
#   make generate   xcodegen で .xcodeproj を作る（生成物はコミットしない）。全画面 SwiftUI（WebView は使わない・かけら帳ネイティブ化設計）
#   make test       XCTest（Web から移した決まり・書く欄の往復）をシミュレータで回す
#   make fixtures   Swift に移した決まりの期待値を Web の関数（src/lib）から書き出す（Tests/Fixtures/rules.json・コミットする）
#   make roundtrip  本番の全かけらの本文を読み取りだけで取り出し（wrangler d1 execute --remote の SELECT・build/ に置く・gitignore）、
#                   書く欄に入れて触らずに出すと1文字も変わらないことを XCTest で確かめる
#   make sim        シミュレータ向けにビルドだけ通す（Team ID 不要・アドホック署名）
#   make run-local  シミュレータで起動し、ローカルの Worker（かけら帳 astro dev :4321・港 ~/work/minato の npm run dev :8793）に向ける
#                   読んだ記事は港の tayori から読む（アプリは便りを直接呼ばない）。港をローカルで回すと出どころの秘密が無いので
#                   cron の材料はスキップになる（vault-log は MINATO_URL=http://127.0.0.1:8793 node scripts/send-to-minato.mjs で入る）
#   make shots      1日のページを実画面で通す UI テスト（ローカルのかけら帳 :4321 が要る）。スクリーンショットは build/stage1-*.png
#   make shots-photos  段階2（写真）の実画面。写真の許可を取り消し、build/stage2-media の写真を入れてから回す（build/stage2-*.png）
#   make shots-events  段階3（予定）の実画面。カレンダーの許可を取り消して許可の流れから通し、最後に拒否の画面も見る（build/stage3-*.png）
#   make shots-chizu  段階4（地図・訪問）の実画面。位置の許可を取り消してから回す（build/stage4-*.png・stage4-google-url.txt）
#   make shots-tsuki  段階5（月カレンダー・検索・書き出し）の実画面（build/stage5-*.png）
#   make run-local-minato-prod  かけら帳はローカル・港は本番（読むだけ。トークンはアプリのキーチェーンに入っていること）
#   make archive    TestFlight 向けアーカイブ（Release・自動署名）。サービストークンをこの Mac のキーチェーンから埋め込む
#   make export-testflight  .ipa を build/export/ に書き出す（送らない）
#   make upload     API キーで App Store Connect へ上げる（Release.local.env と .p8 が要る）
#   make release    archive → upload（ビルド番号は日時で自動）
#   make icon       アプリアイコンを描き直す
#
# Team ID は ~/.config/kazoku-keijiban/team-id（1行・家族掲示板・便りと同じチーム）か `make ... TEAM=XXXXXXXXXX`。

PROJECT = kakera.xcodeproj
SCHEME  = Kakera
BUNDLE  = jp.kechiiiiin.kakera
CONF    = $(HOME)/.config/kazoku-keijiban
TEAM   ?= $(shell cat $(CONF)/team-id 2>/dev/null)
export KAKERA_TEAM_ID = $(TEAM)
PHONE_SIM  = Kakera-iPhone
PHONE_TYPE = iPhone 17
LOCAL_KAKERA = http://127.0.0.1:4321
LOCAL_MINATO = http://127.0.0.1:8793
APP     = build-sim/Build/Products/Debug-iphonesimulator/Kakera.app

ARCHIVE = build/Kakera.xcarchive
# サービストークンの出どころ（ビルドする Mac のキーチェーン。読むだけで書き込まない）
KC_SERVICE ?= kakera-token
SECRETS = Secrets.xcconfig

.PHONY: shots shots-photos shots-events shots-chizu shots-tsuki generate test fixtures roundtrip sim run-local run-local-minato-prod icon clean archive upload export-testflight release require-team require-asc-key

generate:
	xcodegen generate

test: generate
	@mkdir -p build
	@xcrun simctl list devices | grep -q "$(PHONE_SIM) (" || xcrun simctl create "$(PHONE_SIM)" "$(PHONE_TYPE)" > /dev/null
	@set -o pipefail; xcodebuild -project $(PROJECT) -scheme $(SCHEME) -destination 'platform=iOS Simulator,name=$(PHONE_SIM)' \
	  -configuration Debug -derivedDataPath build-sim CODE_SIGN_IDENTITY=- test 2>&1 | tee build/test.log | \
	  grep -E "(error|warning):|Test Suite '.*' (passed|failed)|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)|roundtrip"

fixtures:
	@mkdir -p build
	../node_modules/.bin/esbuild scripts/rule-fixtures.ts --bundle --platform=node --format=esm --target=node20 \
	  --outfile=build/rule-fixtures.mjs --log-level=warning
	node build/rule-fixtures.mjs > Tests/Fixtures/rules.json

# 本番の本文（読み取りだけ）。⚠️ 実名を含むので build/（gitignore）に置き、リポジトリに入れない
BODIES = build/roundtrip/bodies.json
roundtrip: generate
	@mkdir -p build/roundtrip
	cd .. && npx wrangler d1 execute kakera --remote --json --command "SELECT id, body FROM kakera ORDER BY id" > ios/$(BODIES)
	@set -o pipefail; TEST_RUNNER_KAKERA_BODIES="$(CURDIR)/$(BODIES)" xcodebuild -project $(PROJECT) -scheme $(SCHEME) \
	  -destination 'platform=iOS Simulator,name=$(PHONE_SIM)' -configuration Debug -derivedDataPath build-sim CODE_SIGN_IDENTITY=- \
	  -only-testing:KakeraTests/EditorRoundTripTests test 2>&1 | tee build/roundtrip.log | \
	  grep -E "(error):|roundtrip|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)"

sim: generate
	@set -o pipefail; xcodebuild -project $(PROJECT) -scheme $(SCHEME) \
	  -destination 'generic/platform=iOS Simulator' -configuration Debug \
	  -derivedDataPath build-sim CODE_SIGN_IDENTITY=- build 2>&1 | tee build-sim.log | grep -E '(error|warning):|BUILD (SUCCEEDED|FAILED)'
	@echo "✅ シミュレータ向けのビルドは通る"

# DEBUG ビルドだけ: 起動引数でつなぎ先をローカルに上書きする（App/Config.swift）。ローカルの Worker は認証を迂回する（DEV_BYPASS_AUTH）
run-local: sim
	@xcrun simctl list devices | grep -q "$(PHONE_SIM) (" || xcrun simctl create "$(PHONE_SIM)" "$(PHONE_TYPE)" > /dev/null
	@xcrun simctl boot "$(PHONE_SIM)" 2>/dev/null || true
	xcrun simctl install "$(PHONE_SIM)" $(APP)
	xcrun simctl launch --terminate-running-process "$(PHONE_SIM)" $(BUNDLE) -kakeraBaseURL $(LOCAL_KAKERA) -minatoBaseURL $(LOCAL_MINATO)

# 写真の許可は先に与えておく（許可の確認が出ると操作が止まる）。KAKERA_SHOTS は TEST_RUNNER_ で UI テストへ渡る
shots: generate
	@mkdir -p build
	@xcrun simctl list devices | grep -q "$(PHONE_SIM) (" || xcrun simctl create "$(PHONE_SIM)" "$(PHONE_TYPE)" > /dev/null
	@xcrun simctl boot "$(PHONE_SIM)" 2>/dev/null || true
	-@xcrun simctl privacy "$(PHONE_SIM)" grant photos $(BUNDLE) 2>/dev/null
	@set -o pipefail; TEST_RUNNER_KAKERA_SHOTS="$(CURDIR)/build" xcodebuild -project $(PROJECT) -scheme KakeraShots \
	  -destination 'platform=iOS Simulator,name=$(PHONE_SIM)' -configuration Debug -derivedDataPath build-sim CODE_SIGN_IDENTITY=- \
	  -only-testing:KakeraUITests/DayPageShots test 2>&1 | tee build/shots.log | grep -E "(error):|XCTAssert|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)"

# 写真は検証用のもの（撮影日時と位置を EXIF に入れた JPEG・build/stage2-media/*.jpg）。シミュレータのライブラリに足す
shots-photos: generate
	@mkdir -p build
	@xcrun simctl list devices | grep -q "$(PHONE_SIM) (" || xcrun simctl create "$(PHONE_SIM)" "$(PHONE_TYPE)" > /dev/null
	@xcrun simctl boot "$(PHONE_SIM)" 2>/dev/null || true
	@test -f build/stage2-media/.added || { xcrun simctl addmedia "$(PHONE_SIM)" build/stage2-media/*.jpg && touch build/stage2-media/.added; }
	-@xcrun simctl privacy "$(PHONE_SIM)" reset photos $(BUNDLE) 2>/dev/null
	@set -o pipefail; TEST_RUNNER_KAKERA_SHOTS="$(CURDIR)/build" xcodebuild -project $(PROJECT) -scheme KakeraShots \
	  -destination 'platform=iOS Simulator,name=$(PHONE_SIM)' -configuration Debug -derivedDataPath build-sim CODE_SIGN_IDENTITY=- \
	  -only-testing:KakeraUITests/DayPagePhotoShots test 2>&1 | tee build/shots-photos.log | grep -E "(error):|XCTAssert|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)"

# 予定は DEBUG の起動引数で検証用のカレンダー「かけら帳の検証」に入れる。許可 → 拒否の順に2回回す
SHOTS_TEST = TEST_RUNNER_KAKERA_SHOTS="$(CURDIR)/build" xcodebuild -project $(PROJECT) -scheme KakeraShots \
	  -destination 'platform=iOS Simulator,name=$(PHONE_SIM)' -configuration Debug -derivedDataPath build-sim CODE_SIGN_IDENTITY=-
shots-events: generate
	@mkdir -p build
	@xcrun simctl boot "$(PHONE_SIM)" 2>/dev/null || true
	-@xcrun simctl privacy "$(PHONE_SIM)" reset calendar $(BUNDLE) 2>/dev/null
	@set -o pipefail; $(SHOTS_TEST) -only-testing:KakeraUITests/DayPageEventShots/testEvents test 2>&1 | tee build/shots-events.log | \
	  grep -E "(error):|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)"
	-@xcrun simctl privacy "$(PHONE_SIM)" revoke calendar $(BUNDLE) 2>/dev/null
	@set -o pipefail; $(SHOTS_TEST) -only-testing:KakeraUITests/DayPageEventShots/testDenied test 2>&1 | tee build/shots-events-denied.log | \
	  grep -E "(error):|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)"

shots-chizu: generate
	@mkdir -p build
	@xcrun simctl boot "$(PHONE_SIM)" 2>/dev/null || true
	-@xcrun simctl privacy "$(PHONE_SIM)" reset location $(BUNDLE) 2>/dev/null
	-@xcrun simctl privacy "$(PHONE_SIM)" grant calendar $(BUNDLE) 2>/dev/null
	-@xcrun simctl privacy "$(PHONE_SIM)" grant photos $(BUNDLE) 2>/dev/null
	@set -o pipefail; $(SHOTS_TEST) -only-testing:KakeraUITests/DayPageChizuShots test 2>&1 | tee build/shots-chizu.log | \
	  grep -E "(error):|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)"

shots-tsuki: generate
	@mkdir -p build
	@xcrun simctl boot "$(PHONE_SIM)" 2>/dev/null || true
	@set -o pipefail; $(SHOTS_TEST) -only-testing:KakeraUITests/DayPageTsukiShots test 2>&1 | tee build/shots-tsuki.log | \
	  grep -E "(error):|Executed [0-9]+ tests|TEST (SUCCEEDED|FAILED)"

# 港は本番（minato.kechiiiiin.com・トークン付き）を読む。かけらの書き込みはローカルのかけら帳へ
run-local-minato-prod: sim
	@xcrun simctl list devices | grep -q "$(PHONE_SIM) (" || xcrun simctl create "$(PHONE_SIM)" "$(PHONE_TYPE)" > /dev/null
	@xcrun simctl boot "$(PHONE_SIM)" 2>/dev/null || true
	xcrun simctl install "$(PHONE_SIM)" $(APP)
	xcrun simctl launch --terminate-running-process "$(PHONE_SIM)" $(BUNDLE) -kakeraBaseURL $(LOCAL_KAKERA) -minatoBaseURL reset

# ---------------- TestFlight ----------------
# 署名は API キー＋ -allowProvisioningUpdates の自動署名（便り・縁側・家族掲示板と同形）。
# xcodebuild の全文ログ（build/archive.log・build/export.log）には API キーのパスと Key ID が出る。build/ は gitignore 済み
RELEASE_ENV   = Release.local.env
EXPORT_DIR    = build/export
EXPORT_PLIST  = build/ExportOptions.generated.plist
RELEASE_DD    = build/release
DESTINATION  ?= export
# ビルド番号（CFBundleVersion）: 「年月日.1時分」。上げるたびに増える。BUILD_NUMBER= で上書き可
BUILD_NUMBER ?= $(shell date +%Y%m%d.1%H%M)

# API キー（Release.local.env から読む。環境変数でも渡せる）。値は表示しない
env_value = $(strip $(shell sed -n 's/^$(1)=//p' $(RELEASE_ENV) 2>/dev/null | tail -1))
ASC_KEY_ID    ?= $(call env_value,ASC_KEY_ID)
ASC_ISSUER_ID ?= $(call env_value,ASC_ISSUER_ID)
ASC_KEY_PATH  ?= $(call env_value,ASC_KEY_PATH)
ifeq ($(strip $(ASC_KEY_PATH)),)
ASC_KEY_PATH := $(HOME)/.appstoreconnect/private_keys/AuthKey_$(ASC_KEY_ID).p8
endif
ASC_KEY_PATH := $(patsubst ~/%,$(HOME)/%,$(ASC_KEY_PATH))
ifneq ($(and $(ASC_KEY_ID),$(ASC_ISSUER_ID),$(wildcard $(ASC_KEY_PATH))),)
AUTH_FLAGS = -authenticationKeyPath "$(ASC_KEY_PATH)" -authenticationKeyID $(ASC_KEY_ID) -authenticationKeyIssuerID $(ASC_ISSUER_ID)
endif

require-team:
	@test -n "$(TEAM)" || { echo "❌ Team ID がありません（$(CONF)/team-id か TEAM=XXXXXXXXXX）"; exit 1; }

require-asc-key:
	@test -n "$(ASC_KEY_ID)" -a -n "$(ASC_ISSUER_ID)" || { echo "ASC_KEY_ID / ASC_ISSUER_ID がありません。Release.example.env を見て Release.local.env を作ってください"; exit 1; }
	@test -f "$(ASC_KEY_PATH)" || { echo "API キーがありません: ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8"; exit 1; }

## キーチェーン → Secrets.xcconfig（gitignore）→ generate → archive。値は表示しない。無ければ失敗
archive: require-team require-asc-key
	@umask 077; \
	cid=$$(security find-generic-password -s $(KC_SERVICE) -a client-id -w 2>/dev/null) && [ -n "$$cid" ] || { echo "❌ キーチェーンに $(KC_SERVICE) / client-id がありません（Access のサービストークン kakera-ios を入れてください）"; exit 1; }; \
	sec=$$(security find-generic-password -s $(KC_SERVICE) -a client-secret -w 2>/dev/null) && [ -n "$$sec" ] || { echo "❌ キーチェーンに $(KC_SERVICE) / client-secret がありません"; exit 1; }; \
	printf 'KAKERA_ACCESS_CLIENT_ID = %s\nKAKERA_ACCESS_CLIENT_SECRET = %s\n' "$$cid" "$$sec" > $(SECRETS); \
	echo "✅ $(SECRETS) を生成した（値は表示しない・gitignore 済み）"
	xcodegen generate
	@mkdir -p build
	rm -rf $(ARCHIVE)
	@echo "ビルド番号 $(BUILD_NUMBER) で archive します"
	@set -o pipefail; xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Release \
	  -destination 'generic/platform=iOS' -derivedDataPath $(RELEASE_DD) -archivePath $(ARCHIVE) \
	  -allowProvisioningUpdates $(AUTH_FLAGS) CURRENT_PROJECT_VERSION=$(BUILD_NUMBER) archive 2>&1 \
	  | tee build/archive.log | grep -E '(error|warning):|ARCHIVE (SUCCEEDED|FAILED)' ; \
	  grep -q 'ARCHIVE SUCCEEDED' build/archive.log || { echo "archive に失敗しました（全文は build/archive.log）"; exit 1; }
	@echo "できました: $(ARCHIVE)（ビルド $(BUILD_NUMBER)）。上げるなら make upload"

## .xcarchive から App Store Connect 向けの .ipa を build/export/ に書き出す（送らない）
export-testflight: require-team require-asc-key
	@test -d $(ARCHIVE) || { echo "$(ARCHIVE) がありません。先に make archive"; exit 1; }
	rm -rf $(EXPORT_DIR)
	@mkdir -p $(EXPORT_DIR)
	cp ExportOptions.plist $(EXPORT_PLIST)
	@plutil -replace teamID -string "$(TEAM)" $(EXPORT_PLIST)
	plutil -replace destination -string $(DESTINATION) $(EXPORT_PLIST)
	@set -o pipefail; xcodebuild -exportArchive -archivePath $(ARCHIVE) -exportPath $(EXPORT_DIR) \
	  -exportOptionsPlist $(EXPORT_PLIST) -allowProvisioningUpdates $(AUTH_FLAGS) 2>&1 \
	  | tee build/export.log | grep -E '(error|warning):|EXPORT (SUCCEEDED|FAILED)|Upload|Uploaded|uploaded' ; \
	  grep -q 'EXPORT SUCCEEDED' build/export.log || { echo "export に失敗しました（全文は build/export.log）"; exit 1; }
	@if [ "$(DESTINATION)" = export ]; then ls -lh $(EXPORT_DIR)/*.ipa; else echo "App Store Connect へ上げました（処理が済むと TestFlight に出る）"; fi

## API キーで App Store Connect へ上げる（先に make archive）。アプリのレコードは App Store Connect で先に作っておく
upload: require-asc-key
	$(MAKE) export-testflight DESTINATION=upload

release: archive upload

icon:
	swift scripts/gen-icon.swift App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png

clean:
	rm -rf build build-sim build-sim.log $(PROJECT)
	rm -f Secrets.xcconfig
