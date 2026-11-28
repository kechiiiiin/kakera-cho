import SwiftUI

/// 選ぶ所の抜粋（Web の textForPick）。サーバの /api/native/pick-texts で当てて、本文ごとに覚える
@Observable
@MainActor
final class PickTexts {
    static let shared = PickTexts()
    private(set) var texts: [String: String] = [:]

    func text(_ body: String) -> String {
        texts[body] ?? KakeraBody.text(body).replacingOccurrences(of: "\n", with: " ")
    }

    func ensure(_ bodies: [String], cards: LinkCards) async {
        let missing = Array(Set(bodies.filter { texts[$0] == nil }))
        guard !missing.isEmpty else { return }
        do {
            let out = try await API.shared.pickTexts(missing, cards: cards)
            for (b, t) in zip(missing, out) { texts[b] = t }
        } catch {
            Toast.shared.say(error.localizedDescription)
        }
    }
}

/// 行き先のかたちを日付で一つ選ぶ（Web の KatachiPickSheet。かけらたちの直す画面から）
struct KatachiPickSheet: View {
    /// 失敗したら投げる（一覧は開いたまま）
    let onPut: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var store = KakeraStore.shared
    @State private var chosen: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetHead(title: "かたちに入れる", sub: "行き先のかたちを選びます。かたちの中は、書いた順に並びます。")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !store.katachiLoaded {
                        Text("読み込んでいます").emptyNote()
                    } else if store.katachiList.isEmpty {
                        Text("まだかたちがありません").emptyNote()
                    }
                    ForEach(store.katachiList) { k in
                        PickRow(checked: chosen == k.id, action: { chosen = chosen == k.id ? nil : k.id }) {
                            Text(DayText.heading(k.date)).font(Theme.mono(12.5)).foregroundStyle(Theme.muted)
                            if !k.title.isEmpty { Excerpt(text: k.title) }
                        }
                        .ruledRow(first: k.id == store.katachiList.first?.id)
                    }
                }
            }
            HStack(spacing: 10) {
                Button("やめる") { dismiss() }.buttonStyle(GhostButtonStyle()).disabled(busy)
                Spacer()
                Button("入れる") {
                    guard let chosen else { return }
                    busy = true
                    Task {
                        defer { busy = false }
                        do { try await onPut(chosen) } catch { Toast.shared.say(error.localizedDescription) }
                    }
                }
                .buttonStyle(CTAButtonStyle())
                .disabled(chosen == nil || busy)
                .accessibilityIdentifier("putIntoKatachi")
            }
            .padding(.vertical, 12)
        }
        .padding(.horizontal, 18)
        .background(Theme.paper.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .toastOverlay()
        .task { await Toast.shared.guarded { try await store.loadKatachiList() } }
    }
}

/// かけらたちから複数選んで足す（Web の KakeraPickSheet。かたちの読む画面の「かけらを足す」から）
struct KakeraPickSheet: View {
    let onAdd: ([String]) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var store = KakeraStore.shared
    @State private var picks = PickTexts.shared
    @State private var chosen: [String] = []
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetHead(title: "かけらを足す", sub: "かたちの中は、書いた順に並びます。")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !store.nagareLoaded {
                        Text("読み込んでいます").emptyNote()
                    } else if store.nagare.isEmpty {
                        Text("まだかたちになっていないかけらがありません").emptyNote()
                    }
                    ForEach(store.nagare) { k in
                        PickRow(checked: chosen.contains(k.id), thumb: k.body, action: {
                            if chosen.contains(k.id) { chosen.removeAll { $0 == k.id } } else { chosen.append(k.id) }
                        }) {
                            Excerpt(text: picks.text(k.body))
                            Text("\(DayText.heading(k.dayKey)) \(k.hhmm)").font(Theme.mono(11)).foregroundStyle(Theme.muted)
                        }
                        .ruledRow(first: k.id == store.nagare.first?.id)
                    }
                }
            }
            HStack(spacing: 10) {
                Button("やめる") { dismiss() }.buttonStyle(GhostButtonStyle()).disabled(busy)
                Spacer()
                Button("足す（\(chosen.count)）") {
                    busy = true
                    Task {
                        defer { busy = false }
                        do { try await onAdd(chosen) } catch { Toast.shared.say(error.localizedDescription) }
                    }
                }
                .buttonStyle(CTAButtonStyle())
                .disabled(chosen.isEmpty || busy)
            }
            .padding(.vertical, 12)
        }
        .padding(.horizontal, 18)
        .background(Theme.paper.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .toastOverlay()
        .task {
            await Toast.shared.guarded { try await store.loadNagare() }
            await picks.ensure(store.nagare.map(\.body), cards: store.nagareCards)
        }
    }
}

extension View {
    /// .empty-note（灰 13.5pt の一文）
    func emptyNote() -> some View {
        self.font(Theme.gothic(13.5)).foregroundStyle(Theme.muted).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
